---
title: "Self-hosted GitHub Actions runners on EKS with Actions Runner Controller"
description: "How I run GitHub Actions runners on EKS with ARC runner scale sets: Helm charts, sized runner classes, scale to zero, container modes and IAM."
date: 2026-11-22
tags: [github-actions, kubernetes, eks, arc, ci-cd]
draft: false
---

When we moved CI from Jenkins to GitHub Actions at work, GitHub-hosted runners
covered the simple jobs. Two things pushed us to self-hosted runners: we
wanted faster builds on machines we could size, and some jobs needed to reach
private resources inside our VPCs. I set up runners on EKS with Actions
Runner Controller (ARC) and wrote the architecture and usage guide for the
teams using them. Here's how it fits together.

## The two Helm charts

ARC today is two charts, both published by GitHub as OCI artifacts:

- **`gha-runner-scale-set-controller`**: the operator. Install it once per
  cluster.
- **`gha-runner-scale-set`**: one install per runner scale set. Each install
  registers a pool of runners with GitHub and tells the controller how to
  create runner pods.

```bash
helm install arc \
  --namespace arc-systems --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

helm install my-runner-set \
  --namespace arc-runners --create-namespace \
  -f values-general.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Pin a chart `--version` in real use, and keep the controller and scale set
charts on the same version.

For each scale set, the controller runs a listener pod that holds a long-poll
connection to GitHub. When a job is queued for that scale set, the listener
tells the controller, which creates an ephemeral runner pod. The runner takes
one job, finishes, and the pod is deleted.

## `runs-on` is the scale set name

With scale sets, the Helm release name is what workflows target. No label
matching:

```yaml
jobs:
  build:
    runs-on: my-runner-set
```

That's simpler than the older label-based setup, and it makes the runner
choice explicit in every workflow.

## Sized runner classes

One pool for everything wastes money on small jobs and starves big ones. I set
up two classes: a general-purpose scale set for most builds, and a larger one
with more vCPU and memory for heavy image builds and test suites. Each is a
separate Helm release with its own values:

```yaml
# values-large.yaml (illustrative)
githubConfigUrl: https://github.com/my-org
githubConfigSecret: arc-github-app

minRunners: 0
maxRunners: 10

template:
  spec:
    nodeSelector:
      workload: ci-large
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
        command: ["/home/runner/run.sh"]
        resources:
          requests:
            cpu: "4"
            memory: 8Gi
          limits:
            memory: 8Gi
```

Use a GitHub App for `githubConfigSecret` rather than a personal access
token. The app's credentials live in a Kubernetes secret, it isn't tied to a
person, and its permissions are explicit.

Teams pick the class in `runs-on`. The usage guide's main job was telling them
which one to choose and when.

## Scale to zero and ephemeral runners

`minRunners: 0` means no runner pods exist when no jobs are queued. The
listener stays up (it's small), and runners appear on demand. You trade a
little startup time on the first job for not paying for idle capacity. If that
startup matters, set `minRunners` to a small number for the busiest scale set
during working hours.

Runners are ephemeral by design: one job, one pod. That's a security and
reliability win. Nothing leaks between jobs, and no build depends on state a
previous build left behind. It also means caches don't persist on the runner,
so use `actions/cache` or registry-based Docker layer caching instead of
relying on local disk.

## Docker-in-Docker vs. kubernetes mode

Most CI jobs need containers: building images, or running steps inside a
`container:` job. ARC offers two ways to support that, set with
`containerMode.type`.

**`dind`** adds a Docker-in-Docker sidecar to each runner pod. Jobs see a
normal Docker daemon, so `docker build`, service containers and `container:`
jobs work the way they do on GitHub-hosted runners. The cost: the dind
sidecar runs privileged.

```yaml
containerMode:
  type: dind
```

**`kubernetes`** mode runs job containers as separate pods through the
runner container hooks, with no privileged daemon. It needs a persistent
volume for the work directory, and `docker build` doesn't work out of the box,
so image builds need a daemonless builder.

```yaml
containerMode:
  type: kubernetes
  kubernetesModeWorkVolumeClaim:
    accessModes: ["ReadWriteOnce"]
    storageClassName: gp3
    resources:
      requests:
        storage: 10Gi
```

My rule of thumb: if most of your jobs build Docker images and the cluster is
dedicated to CI, dind is the pragmatic choice. If the cluster is shared or
your security baseline forbids privileged pods, use kubernetes mode and accept
the extra work on image builds.

## Nodes

Runner pods need somewhere to land. Keep them off the nodes running your
applications: a dedicated node pool with a taint, and a matching toleration
and node selector in the scale set template.

With Karpenter, a NodePool per runner class works well. Pods go pending when
jobs queue, Karpenter adds right-sized nodes, and consolidation removes them
when the runners finish. That pairs naturally with `minRunners: 0`: no jobs,
no runner pods, and soon no runner nodes. Spot capacity is reasonable for CI
since a failed job can be retried, but keep deploy jobs on on-demand.

## IAM: no keys on the runner

Runners often need AWS access. Don't put keys in secrets, and don't rely on
the node's instance role, since that gives every pod on the node the same
permissions.

Two good options:

- **OIDC from the workflow** with `aws-actions/configure-aws-credentials`.
  The job gets credentials for a role scoped to its repository. This works the
  same on hosted and self-hosted runners and is what I prefer for deploys.
- **IRSA or EKS Pod Identity** on the runner's service account, for baseline
  access every job in that scale set needs, such as pulling from a private
  registry.

Workflow OIDC keeps permissions tied to the repo and branch. Pod-level roles
are tied to the scale set, so keep them small.

## Lessons

- Use the scale set charts and target runners by scale set name. It's simpler
  than label matching.
- Size runner classes to your workloads and document which one to use.
  Without a guide, everyone picks the biggest.
- Scale to zero, and let the node layer scale down behind it.
- Decide on dind vs. kubernetes mode deliberately. It's a security choice as
  much as a technical one.
- Keep cloud permissions per repo through OIDC, not per node.
