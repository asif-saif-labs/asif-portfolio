---
title: "Quarterly cost reviews across 10 AWS accounts: what actually showed up"
description: "What a quarterly AWS cost review across about 10 accounts turned up: untagged databases, oversized Aurora, idle services and EKS extended support."
date: 2026-11-22
tags: [aws, finops, cost-optimization, rds, eks]
draft: true
---

Every quarter at work I go through the AWS bill for about 10 accounts and
look for money we're spending without meaning to. There's rarely one big
mistake. It's a handful of things that each looked reasonable when someone
set them up.

This is what the recent rounds turned up, with the numbers labelled for what
they are: most are estimates, and an estimate isn't a saving until something
changes.

## Start with tags, or you can't tell who owns anything

Cost Explorer can only group costs by owner, product or environment if the
resources carry those tags, and if the tags are activated as cost allocation
tags in the billing console. One piece of work from these reviews was tagging
Redshift and RDS across 6 accounts.

Find what's missing first:

```bash
aws resourcegroupstaggingapi get-resources \
  --resource-type-filters rds:db rds:cluster redshift:cluster \
  --query 'ResourceTagMappingList[?!not_null(Tags[?Key==`owner`])].ResourceARN' \
  --output text
```

That lists resources the tagging API knows about with no `owner` tag. It's
the list to take to teams. Untagged spend is the spend nobody defends, and
also the spend nobody turns off.

## Services nobody uses

The cheapest saving is turning off things that serve nobody, and
decommissioning unused services is a regular outcome of these reviews. They
are usually services that still run because nobody was sure they could be
deleted.

The process I follow:

1. Check traffic and usage: request counts, connections, invocations over
   the last few weeks.
2. Find an owner, and ask in writing.
3. Get a go-ahead before deleting. Snapshot databases first.
4. Remove the whole stack, including listener rules, target groups, DNS and
   alarms. Leftover alarms keep generating tickets long after the service is
   gone.

## Databases that sit idle

Non-production databases often run around the clock and are used during
office hours. Earlier, I set up a Lambda that pauses idle RDS. A minimal
version of the idea is a scheduled function that stops instances by tag:

```python
import boto3

rds = boto3.client("rds")

def handler(event, context):
    for db in rds.describe_db_instances()["DBInstances"]:
        tags = {t["Key"]: t["Value"] for t in db.get("TagList", [])}
        if tags.get("auto-stop") == "true" and db["DBInstanceStatus"] == "available":
            rds.stop_db_instance(DBInstanceIdentifier=db["DBInstanceIdentifier"])
```

Two things to know before relying on this. A stopped RDS instance or Aurora
cluster starts again on its own after seven days, so the schedule has to stop
it again. And while it's stopped you still pay for storage and backups, just
not compute.

## An Aurora Serverless cluster sized for a peak it doesn't have

One Aurora Serverless cluster was running at 91 ACU, against a maximum of
128 ACU, while CPU sat around 14%. Aurora Serverless v2 scales on more than CPU, with
memory and connections in the mix, so low CPU alone doesn't prove it's too
big. But that much capacity for that little CPU is worth a look. It's likely
oversized, and the next step is to check memory, connections and the
workload before lowering the maximum.

What to pull before changing anything:

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity \
  --dimensions Name=DBClusterIdentifier,Value=my-cluster \
  --start-time 2026-10-01T00:00:00Z --end-time 2026-11-01T00:00:00Z \
  --period 3600 --statistics Average Maximum
```

Look at the same window for `CPUUtilization`, `FreeableMemory` and
`DatabaseConnections`. If the cluster stays high with low CPU, look at what
holds it there: buffer cache, long-running connections, or a minimum ACU set
too high.

## ECS services larger than their load

Task sizes on ECS are often set once and never revisited. For one product,
comparing what the services ask for with what they use gave an estimate of
about **$880/month** saved by right-sizing. That's the
estimate, not a realised saving; it depends on teams agreeing to the new sizes
and the services behaving well on them.

## Would Lambda be cheaper? Not yet

For the same product, I ran a read-only proof of concept: would moving its
Django APIs from ECS to Lambda save money? The answer was **$0 to $230 a
month**, and only after a big refactor. With right-sizing on ECS worth more
than that for a fraction of the effort, I didn't recommend the move.

This is a common result. Lambda wins on spiky, low-volume traffic. For an API
with steady traffic and a framework that expects a long-running process, the
refactor cost can easily outweigh the saving.

## EKS extended support

EKS charges more for clusters running a Kubernetes version past standard
support. The control plane fee goes from $0.10 per cluster per hour to $0.60
per cluster per hour. That's easy to miss, because nothing breaks. For one
product, moving off extended support came to **$744/month**.

The fix is the upgrade you'd have to do anyway. The cost line just makes the
case for doing it now.

```bash
aws eks describe-cluster --name my-cluster \
  --query 'cluster.[version,upgradePolicy.supportType]' --output text
```

## What I'd tell anyone starting these reviews

- **Tag first.** Without owner tags, every finding starts with a search for
  who to ask.
- **Separate estimates from savings.** Report the estimate, then report again
  once the change is live and a full month has been billed.
- **Look at utilisation, not just spend.** An expensive resource that's busy
  is fine. A cheap one that's idle is still waste.
- **Prefer small, boring changes.** Right-sizing and turning things off beat
  re-architecting on cost per hour of effort.
- **Watch the silent price changes.** Extended support charges show up on the
  bill without any outage to remind you.
- **Write it to the owners.** A review only saves money if the teams that own
  the resources act on it.

Checklist for a quarterly pass:

- [ ] Untagged RDS, Redshift and other big-ticket resources
- [ ] Services with no traffic, raised for decommissioning
- [ ] Non-production databases running 24/7
- [ ] Aurora Serverless max and min ACU against real use
- [ ] ECS task sizes against Container Insights
- [ ] EKS and RDS engine versions in extended support
- [ ] Last quarter's estimates checked against the actual bill
