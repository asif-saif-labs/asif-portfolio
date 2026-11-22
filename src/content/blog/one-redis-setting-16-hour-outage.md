---
title: "One Redis setting, a 16-hour outage: a blameless RCA"
description: "A Django service on ECS was down for about 16 hours because Redis had no password and the deployment circuit breaker was off. What happened and what we changed."
date: 2026-11-22
tags: [aws, ecs, django, redis, incident-response]
draft: true
---

A production Django service on ECS was down for roughly 16 hours, overnight
and into the next morning. Nobody had touched the application code. I found
it while working through a queue of alert tickets, and the cause came down to
one setting: the Redis cache the app pointed at had no password.

This is the write-up, in a blameless format. The goal is to explain why the
system let one config mistake turn into a long outage, not to find someone
to blame.

## Summary

- **Impact:** a production Django service on ECS returned errors for
  roughly 16 hours. The load balancer had no healthy targets to send traffic to.
- **Trigger:** new tasks failed Django's startup checks because the Redis
  cache configuration had no password. Every new task exited at startup.
- **Why it lasted so long:** the ECS deployment circuit breaker was off, so
  ECS kept retrying the broken deployment instead of rolling back, and nothing
  alerted on tasks starting and dying over and over.

## Timeline (high level)

1. **Several days before:** deployments started failing. New tasks crashed on
   startup. Because ECS only removes old tasks once new ones are healthy, the
   old tasks kept serving traffic and the problem was invisible from outside.
2. **The outage starts:** the last healthy tasks were gone. ECS had nothing
   healthy to put behind the target group, and the ALB started returning
   errors to every request.
3. **About 16 hours later:** the service was serving again.
4. **Later that week:** while triaging a batch of alert tickets, I traced the
   alerts for this service back to the crash loop and wrote this RCA.

## Root cause

Django runs its system checks when the app starts. The cache configuration
pointed at Redis without a password, and the startup checks failed on it. When
a check fails at startup, the process exits. The container exits, ECS marks
the task as stopped, and the service scheduler starts a new one to meet the
desired count. The new one fails the same way.

That is a crash loop. Each task lived for seconds, never passed the target
group health check, and never got traffic.

The interesting part is not the missing password. Config mistakes happen.
The interesting part is that the platform had every chance to stop this and
didn't.

## Contributing factors

### The deployment circuit breaker was off

ECS has a deployment circuit breaker for rolling updates. When it is on, ECS
counts tasks that fail to reach a running, healthy state during a deployment.
After enough failures, it marks the deployment as failed, and with `rollback`
enabled it goes back to the last deployment that completed.

With it off, ECS keeps trying the new task definition. There is no "give up"
state. A bad deployment does not fail; it just keeps going, which is what
happened here.

### No alert on task churn

The service had alerts on the load balancer side, which fired once there
were no healthy targets. Nothing alerted on the earlier signal: tasks
starting and stopping again and again, for days, while old tasks still
carried the traffic. That was the window where the problem was cheap to fix.

### Config was not checked before deploy

The cache settings came from the environment at runtime. Nothing in the
pipeline checked that the values the app needed were present and usable
before a new task definition was rolled out.

## Fixes and prevention

### 1. Turn on the circuit breaker with rollback

In Terraform, on the `aws_ecs_service`:

```hcl
resource "aws_ecs_service" "app" {
  name            = "my-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 2

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
}
```

`minimum_healthy_percent = 100` means ECS will not stop old tasks until new
ones are healthy. With the circuit breaker on, a deployment like this one
fails and rolls back, and the old version keeps serving.

### 2. Health checks that mean "ready"

The target group health check should hit a path that proves the app can serve
a request, not just that the port is open. For a Django app that depends on
its cache, a small readiness view that touches the cache is enough. Keep it
cheap and unauthenticated, and don't let it call slow downstream services.

A container-level health check in the task definition helps ECS see unhealthy
tasks even before the load balancer does.

### 3. Validate config before it ships

Run the same checks in CI that the app runs at startup, with production-like
settings:

```bash
python manage.py check --deploy
```

And check that the required environment variables and secrets exist for the
target environment before the deploy step runs. A failed pipeline is a much
better place to find a missing Redis password than a crash loop in production.

### 4. Alert on task churn and failed deployments

ECS publishes service events and deployment state changes to EventBridge. A
rule on failed deployments is a direct signal:

```json
{
  "source": ["aws.ecs"],
  "detail-type": ["ECS Deployment State Change"],
  "detail": {
    "eventName": ["SERVICE_DEPLOYMENT_FAILED"]
  }
}
```

That only fires when the circuit breaker is on, which is one more reason to
enable it. For task churn, alert on `ECS Task State Change` events where
tasks stop with a non-zero exit code, or on running task count below desired
count for more than a few minutes. Either would have flagged this days before
the outage.

## What I took from it

The missing password was a one-line fix. The outage lasted 16 hours because
of the defaults around it: no circuit breaker, no alert until the very last
healthy task was gone, and no check before deploy.

Checklist I now run on any ECS service I touch:

- [ ] `deployment_circuit_breaker` enabled with `rollback = true`
- [ ] `minimum_healthy_percent` keeps old tasks until new ones are healthy
- [ ] Target group health check hits a path that proves the app is ready
- [ ] Startup checks run in CI with production-like settings
- [ ] Required config and secrets checked before deploy
- [ ] Alert on failed deployments and on running count below desired
- [ ] Alerts route to someone who will see them outside office hours
