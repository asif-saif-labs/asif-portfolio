---
title: "Splitting environments off a shared ALB with Terraform, without recreating anything"
description: "Moving UAT and a playground environment to their own load balancer with terraform state mv and an import block, and the production move that didn't go as smoothly."
date: 2026-11-22
tags: [terraform, aws, alb, ecs]
draft: true
---

At work, several environments of a client app sat behind one shared
Application Load Balancer. That was fine until UAT and a "playground"
environment needed their own WAF rules, which meant their own load balancer.
The catch: the target groups, listener rules and ECS services already existed
in Terraform state under the shared ALB's modules, and I didn't want Terraform
to destroy and recreate any of them.

## Why a naive refactor recreates everything

Terraform tracks resources by address. If a target group lives at
`module.shared_lb.aws_lb_target_group.this["uat"]` and you move the code into a
new module, the new address is empty in state. The plan then says: destroy the
old one, create a new one. For a target group that's attached to a running ECS
service, that's an outage waiting to happen.

The fix is to tell Terraform the object moved, not that it's new.

## Moving state instead of resources

For the UAT and playground split I used `terraform state mv`, about nine
moves in total: target groups, listener rules and the bits that hung off them.
Each one looks like this (addresses are illustrative):

```bash
# Always keep a copy of state before surgery
terraform state pull > backup-$(date +%Y%m%d-%H%M).tfstate

terraform state mv \
  'module.shared_lb_tgs.aws_lb_target_group.this["uat-api"]' \
  'module.uat_lb_tgs.aws_lb_target_group.this["uat-api"]'
```

If you prefer the change to be reviewable in the pull request, a `moved` block
does the same thing declaratively:

```hcl
moved {
  from = module.shared_lb_tgs.aws_lb_target_group.this["uat-api"]
  to   = module.uat_lb_tgs.aws_lb_target_group.this["uat-api"]
}
```

`moved` blocks only work within one state, and they stay in the code as
history. `state mv` is immediate and leaves no trace in the repo, so write the
commands down in the PR description either way.

One resource couldn't be moved: the playground ECS service had to be brought
under a new address that had no state at all. For that, an `import` block
(Terraform 1.5+):

```hcl
import {
  to = module.playground_service.aws_ecs_service.this
  id = "my-cluster/my-app-playground"
}
```

The plan then shows `will be imported` instead of `will be created`, and you
can see any drift between your code and the live service before anything is
touched.

## Reading the plan until it's boring

The rule I hold myself to: don't apply until the plan shows only what I meant
to change. For this split that meant the new ALB, its listeners and WAF
association as creates, listener rules moving, DNS records updating, and
nothing being replaced that serves traffic.

The words to search for are `must be replaced`, `-/+` and `+/-`. Saving the
plan and filtering it makes this faster than scrolling:

```bash
terraform plan -out=tfplan
terraform show -json tfplan \
  | jq -r '.resource_changes[]
           | select(.change.actions | index("delete"))
           | "\(.change.actions | join(",")) \(.address)"'
```

Anything in that list that's a target group, a listener or an ECS service gets
a hard look. I re-ran the plan after each round of fixes until the list held
only the things I expected. The UAT and playground move went through with no
downtime.

## The production move that didn't

Later I moved a production Django backend from the shared ALB to a dedicated
one. Same approach, a targeted plan that looked right, an agreed change
window. The apply failed halfway and the backend was down for about 5 to 10
minutes.

The cause was in the target group module. It sets `create_before_destroy` on
the target group. When a resource with `create_before_destroy` is replaced,
Terraform applies the same ordering to the resources that depend on it, so the
listener rule was also created before the old one was destroyed, even though
the plan displayed it as a normal `-/+`.

That ordering is impossible here. An ALB target group can only be associated
with one load balancer, so AWS rejected the new listener rule on the new ALB
(`TargetGroupAssociationLimit`) while the old rule on the shared ALB still held
the target group. By then the DNS record had already been updated to point at
the new ALB, which had no working rule. Clients reached a load balancer that
couldn't route them.

Deleting the old listener rule by hand and re-applying fixed it:

```bash
aws elbv2 delete-rule --rule-arn <OLD_RULE_ARN>
terraform apply -target=module.my_app_prod_tgs
```

I wrote up the root cause and a rollback plan (point the module inputs back at
the shared ALB and apply). Next time I'd do one of these:

- Delete the old listener rule immediately before the apply, so there's
  nothing to collide with.
- Split it into two targeted applies: first the new ALB, listener and WAF,
  then the target group move, with the old rule removed in between.
- Keep DNS out of the first apply, and switch it only once the new ALB has
  healthy targets.

## Things that replace when you don't expect them

A few patterns that turn a "move" into a destroy/create:

- **Names on target groups.** Target group names are unique per account and
  region. Change the name and it's a replacement, and with
  `create_before_destroy` the new one can collide with the old name. Using
  `name_prefix` avoids the collision.
- **Changing protocol, port or VPC** on a target group forces replacement.
- **`create_before_destroy` propagating** to dependent resources, as above.

## Checklist

1. Back up state (`terraform state pull`) before any `state mv`.
2. Prefer `moved`/`state mv` and `import` over letting Terraform destroy and
   create.
3. Filter the saved plan for deletes and replacements, and justify every one.
4. Check whether any module in the path uses `create_before_destroy`.
5. Remember a target group can sit behind only one ALB. Plan the order of rule
   removal and creation yourself.
6. Move DNS last, once the new load balancer has healthy targets.
7. Write the rollback down before the window, not during it.
