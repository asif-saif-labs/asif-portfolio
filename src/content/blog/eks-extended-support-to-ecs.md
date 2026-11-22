---
title: "Getting off EKS extended support: why we moved a product to ECS"
description: "A product stuck on EKS 1.24 was costing $744 a month in extended support. Instead of a chain of upgrades, we moved its six services to ECS."
date: 2026-11-22
tags: [aws, eks, ecs, kubernetes, cost]
draft: false
---

At work, one product was still running on an EKS 1.24 cluster long after 1.24
left standard support, which meant it was in extended support and adding
$744 a month to the bill. This post is about why we didn't upgrade it, and about a
separate incident that shows what version drift on EKS costs you even when
the bill doesn't.

## How EKS support pricing works

Every EKS cluster pays an hourly fee for the control plane. Each Kubernetes
minor version gets a period of standard support after its release on EKS.
When that ends, the version moves into extended support for a further period,
and AWS charges a higher hourly fee per cluster for as long as it stays there.
When extended support ends too, AWS upgrades the control plane for you.

The fee is per cluster, not per node, so it doesn't matter how small the
workload is. A quiet cluster on an old version costs as much in extended
support as a busy one. AWS also lets you set a cluster's upgrade policy so it
gets upgraded automatically at the end of standard support rather than moving
into extended support. Worth knowing before the bill tells you.

The extended support fee is a signal, not just a cost. It means the cluster
is several minor versions behind, and every month it stays there the upgrade
gets harder.

## Why not just upgrade?

EKS upgrades the control plane one minor version at a time. Getting from 1.24
to a version in standard support meant a chain of upgrades, and each step
brings its own work:

- checking manifests and Helm charts for removed APIs
- upgrading add-ons (VPC CNI, CoreDNS, kube-proxy) to versions that match
- upgrading the node groups and whatever provisions nodes
- testing the application at each step

We looked at what the product actually ran: 6 services, deployed to 3
environments, plus Kafka. Nothing in it needed Kubernetes specifically: no
operators, no custom resources, no complex scheduling. It was a set of
containerised services and a message broker.

For that shape, the cluster was overhead. Kubernetes gave us a control plane
to upgrade every year, add-ons to keep compatible, and a node layer to manage,
in exchange for features the product didn't use.

## The move to ECS

Instead of the upgrade chain, I migrated the product to ECS. Each of the 6
services became an ECS task definition and service, in each of the 3
environments, and the product got new MSK clusters for Kafka.

A trimmed, illustrative task definition:

```hcl
resource "aws_ecs_task_definition" "my_service" {
  family                   = "my-app-my-service"
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "my-service"
    image     = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/my-service:1.0.0"
    essential = true
    portMappings = [{ containerPort = 8080 }]
    environment = [
      { name = "KAFKA_BOOTSTRAP_SERVERS", value = var.msk_bootstrap_brokers }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/my-app"
        awslogs-region        = "eu-west-1"
        awslogs-stream-prefix = "my-service"
      }
    }
  }])
}
```

Most of the migration was translation. A Kubernetes Deployment, Service and
ConfigMap map to an ECS task definition, service and environment variables or
parameters. Health checks move to the load balancer target group and the
container definition. Pod-level IAM becomes the task role.

Once all three environments were running on ECS and the old cluster had
nothing left on it, we deleted it, and the extended support charge went with
it.

## When ECS is the better fit

I like Kubernetes, and this isn't an argument against it. But for a product
like this one, ECS is the better fit when:

- the workload is a handful of stateless services
- you don't use operators, CRDs or the Kubernetes ecosystem in a way that
  matters
- nobody on the team owns the cluster as a platform
- you want AWS to own the control plane's lifecycle entirely

ECS has no version to upgrade. There's no control plane fee, no add-on matrix,
no node AMI to keep in step. The trade is less flexibility, and if you need
what Kubernetes gives you, that trade isn't worth it.

## A separate lesson: version drift breaks things quietly

A different EKS cluster at work taught the same lesson from another angle.
Its control plane was on 1.33, but the nodes were still on 1.30. Kubernetes
allows kubelets to be a few minor versions behind the API server, and 1.30
against 1.33 is right at that limit. The real problem was everything around
the nodes.

Karpenter was on v0.27, a release from long before 1.33 existed, and it
couldn't create new nodes. Several cluster add-ons were crash-looping. The
cluster was still serving traffic on its existing nodes, but it had lost the
ability to scale or replace them.

The remediation had two parts:

1. **A phased node upgrade.** Move the nodes forward step by step instead of
   jumping, checking workloads at each stage.
2. **Karpenter v0.27 to v1.** This isn't a version bump. Karpenter's APIs
   changed along the way: `Provisioner` and `AWSNodeTemplate` were replaced
   by `NodePool` and `EC2NodeClass`. The upgrade guide routes you through
   intermediate releases, and the CRDs and manifests have to be migrated as
   you go.

```bash
# What I check first on any EKS cluster now
aws eks describe-cluster --name my-cluster --query "cluster.version"
kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion
aws eks list-addons --cluster-name my-cluster
helm list -A | grep -i karpenter
```

Nothing about that cluster was urgent until suddenly it was. Each piece had
drifted on its own, and together they stopped the cluster from healing.

## Lessons

- The extended support fee is per cluster and adds up regardless of workload
  size. Check every cluster's version against the support calendar.
- Before planning a chain of upgrades, ask whether the workload needs
  Kubernetes at all. For a few stateless services, ECS removes the whole
  upgrade problem.
- Version drift isn't just the control plane. Nodes, add-ons and node
  provisioners like Karpenter all have to move together.
- Upgrade a little, often. Two versions behind is a task; five is a project.
