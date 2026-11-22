---
title: "Graceful Celery worker shutdown on ECS deployments"
description: "Deploys were killing in-flight Celery tasks. A longer stopTimeout, ECS task scale-in protection and draining before deploys fixed it."
date: 2026-11-22
tags: [aws, ecs, celery, python, deployments]
draft: false
---

At work, a Django backend runs its background jobs on Celery workers in ECS.
Every deployment replaced the worker tasks, and whatever those workers were
in the middle of was killed.

The cause wasn't Celery. It was how ECS stops a container, and how little
time it gives by default.

## What ECS does when it stops a task

During a rolling deployment, ECS starts new tasks and stops old ones. To stop
a container it:

1. sends `SIGTERM` (or the image's `STOPSIGNAL`) to the container's main
   process,
2. waits for the container's `stopTimeout`,
3. sends `SIGKILL` if the process is still running.

The default wait is **30 seconds**. On Fargate you can raise `stopTimeout` up
to a maximum of **120 seconds**. On the EC2 launch type the default comes from
the agent's `ECS_CONTAINER_STOP_TIMEOUT` setting, and a task definition value
overrides it.

## What Celery does with SIGTERM

`SIGTERM` triggers Celery's **warm shutdown**: the worker stops taking new
messages and waits for the tasks it's currently running to finish, then
exits. That's exactly what you want during a deploy, as long as it gets enough
time.

With a 30-second stop timeout, any task longer than that is killed by
`SIGKILL` halfway through. Warm shutdown never had a chance.

There's also a trap that makes the timeout irrelevant: if the container runs
Celery through a shell, the shell is PID 1 and may not forward the signal.

```dockerfile
# Shell form: /bin/sh is PID 1, Celery may never see SIGTERM
CMD celery -A my_app worker -l info

# Exec form: Celery is PID 1 and receives SIGTERM directly
CMD ["celery", "-A", "my_app", "worker", "-l", "info"]
```

If you need a wrapper script, end it with `exec celery ...` so Celery
replaces the shell.

## Fix 1: a longer stopTimeout

The first change was to give the worker container a longer `stopTimeout` in
the task definition:

```hcl
container_definitions = jsonencode([
  {
    name        = "celery-worker"
    image       = var.image
    essential   = true
    command     = ["celery", "-A", "my_app", "worker", "-l", "info"]
    stopTimeout = 120
  }
])
```

That covers tasks that finish within two minutes. For anything longer, a
bigger stop timeout isn't available on Fargate, so you need the next two
fixes.

## Fix 2: task scale-in protection while work is running

ECS **task scale-in protection** marks a task as not to be stopped by service
scale-in or by deployments. A protected task is left alone until protection is
removed or expires, so a deploy waits for it rather than killing it.

A task sets protection on itself through the ECS agent endpoint, available in
the container as `$ECS_AGENT_URI`. The task role needs
`ecs:UpdateTaskProtection` (and `ecs:GetTaskProtection` if you read it). An
illustrative helper:

```python
import os
import requests

def set_task_protection(enabled: bool, minutes: int = 60) -> None:
    agent_uri = os.environ.get("ECS_AGENT_URI")
    if not agent_uri:
        return  # not running on ECS (local dev, tests)
    body = {"ProtectionEnabled": enabled}
    if enabled:
        body["ExpiresInMinutes"] = minutes
    resp = requests.put(f"{agent_uri}/task-protection/v1/state", json=body, timeout=5)
    resp.raise_for_status()
```

Turn protection on when a worker starts a long job and off when it finishes.
Two things to get right:

- **Always set an expiry.** If a worker hangs while protected, the expiry is
  what lets the deployment finish eventually.
- **Mind concurrency.** A worker with several processes is one ECS task.
  Only remove protection when *no* process is busy, or one task finishing
  unprotects another that's still running.

## Fix 3: drain before deploying

The cleanest deploy is one where the old workers have nothing to do. Before a
deploy, stop the old workers consuming from their queues and let them finish
what they have:

```bash
# Stop consuming; tasks already running carry on
celery -A my_app control cancel_consumer my-queue

# Wait until nothing is active
celery -A my_app inspect active
```

New messages stay in the broker and are picked up by the new workers once
they start.

## acks_late and visibility timeouts

By default Celery acknowledges a message just before running the task. If
the worker is killed mid-task, that message is gone. With
`task_acks_late = True`, the ack happens after the task finishes, so a
killed task's message goes back to the queue and runs again. That's safer,
but only if your tasks are idempotent: running twice must be harmless.

With Redis or SQS as the broker, an unacknowledged message is redelivered
after the **visibility timeout**. If that's shorter than your longest task,
a task that's still running fine gets delivered to a second worker. Set the
visibility timeout above your longest task's runtime.

Also consider `worker_prefetch_multiplier = 1` for long tasks, so a worker
doesn't reserve a batch of messages it won't get to before a deploy stops it.

```python
# celery config (illustrative)
task_acks_late = True
worker_prefetch_multiplier = 1
broker_transport_options = {"visibility_timeout": 7200}  # seconds; above the longest task
```

## Checklist

1. Run Celery in exec form so it receives `SIGTERM` as PID 1.
2. Raise the worker container's `stopTimeout` (max 120 s on Fargate).
3. Use ECS task scale-in protection for work longer than that, with an
   expiry, and account for worker concurrency.
4. Drain queues from the old workers before deploying.
5. Use `task_acks_late` only with idempotent tasks.
6. Keep the broker's visibility timeout above your longest task.
