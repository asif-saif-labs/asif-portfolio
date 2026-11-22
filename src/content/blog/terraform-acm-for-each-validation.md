---
title: "Terraform for_each and ACM DNS validation: why your plan fails"
description: "My ACM validation records failed at plan time because for_each was keyed on a value AWS only knows after apply. Key by domain name instead."
date: 2026-11-22
tags: [terraform, aws, acm, route53, cloudfront]
draft: false
---

This site sits behind CloudFront, so it needs an ACM certificate in
`us-east-1`. I wanted one certificate for the apex and a wildcard,
`example.com` and `*.example.com`, validated through DNS records in the
Route 53 zone that Terraform also manages. The first `terraform plan` never
got as far as showing a diff.

## The first version

This is the shape you find in a lot of examples and old answers. It keys the
validation records by the record name ACM asks for, and groups duplicates with
`...` because the apex and the wildcard can produce the same record:

```hcl
resource "aws_route53_record" "acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard_us_east_1.domain_validation_options :
    dvo.resource_record_name => dvo...
  }

  zone_id = aws_route53_zone.main.zone_id
  name    = each.value[0].resource_record_name
  type    = each.value[0].resource_record_type
  ttl     = 300
  records = [each.value[0].resource_record_value]
}
```

And the plan:

```text
Error: Invalid for_each argument

...

The "for_each" map includes keys derived from resource attributes that
cannot be determined until apply, ...
```

## Why it fails

Terraform has to know every key of a `for_each` map during plan. The keys
become the instance addresses, like
`aws_route53_record.acm_validation["..."]`, and Terraform can't plan
instances it can't name.

`resource_record_name` is the random-looking `_abc123.example.com.` CNAME that
ACM generates. It doesn't exist until the certificate request has been made,
which happens during apply. On a fresh plan the certificate is still "to be
created", so the record name is unknown, so the map keys are unknown, so the
plan stops.

If the certificate already exists in state, the same code plans fine. That's
why this pattern looks like it works: it works on the second run, or on a
project where someone added the records after the certificate was already
there.

## The fix: key by something known at plan time

`domain_name` comes from your own configuration. The AWS provider fills it in
for each validation option at plan time, while the record name, type and value
stay unknown. So the domain name goes in the key, and everything ACM generates
goes in the values:

```hcl
resource "aws_acm_certificate" "wildcard_us_east_1" {
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ACM gives the apex and its wildcard the same validation CNAME, so one record
# (taken from the apex entry) validates both names.
resource "aws_route53_record" "acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard_us_east_1.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
    if dvo.domain_name == var.domain_name
  }

  zone_id         = aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "wildcard_us_east_1" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.wildcard_us_east_1.arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}
```

Unknown values are fine in the values of a `for_each` map. Terraform plans one
instance per key and shows `(known after apply)` for the attributes it can't
fill in yet.

## Why the filter

ACM validates `example.com` and `*.example.com` with the same CNAME. Without
the `if`, the map has two keys, `example.com` and `*.example.com`, and
Terraform creates two resources that manage one and the same DNS record. With
`allow_overwrite` they don't error, but they do step on each other, and
destroying one deletes the record the other thinks it owns.

The filter keeps only the apex entry. One record, one resource, and it
validates both names. The filter is on `dvo.domain_name`, which is known at
plan time, so it doesn't bring back the original problem. Filtering on
`resource_record_name` would.

If you add a SAN that isn't covered by the apex, say `api.other-domain.com`,
this filter would drop its record. Then you'd widen the condition rather than
remove it.

## The plan, and validation

With the fix, the plan ran cleanly: `Plan: 7 to add`. The certificate,
the validation record and the `aws_acm_certificate_validation` resource were
among them.

`aws_acm_certificate_validation` doesn't create anything in AWS. It waits until
ACM reports the certificate as issued. ACM checks the CNAME through public DNS,
not by looking inside your Route 53 zone. So the record existing in the zone
is not enough: the domain's nameservers at the registrar have to point to
Route 53 first. For me, validation completed once the nameservers pointed to
Route 53. If yours sits waiting, check delegation before anything else:

```bash
dig NS example.com +short
dig CNAME _abc123.example.com +short
```

The first should list `awsdns` nameservers, the second the ACM validation
target.

## Why not just use -target

The other common answer is to create the certificate first, then everything
else:

```bash
terraform apply -target=aws_acm_certificate.wildcard_us_east_1
terraform apply
```

It works, and I don't like it:

- The configuration still can't plan from empty. Every new environment, every
  rebuild, every teammate needs to know the two-step dance.
- `-target` skips everything not in the dependency graph of the target, so the
  first apply is not a full picture of what will change.
- In CI you either hard-code the extra step or the pipeline fails on the
  first run.
- It hides the actual bug. The keys are wrong. Fixing the keys makes the
  problem go away for good.

`-target` is for getting out of a hole. It shouldn't be part of the normal
way a stack is built.

## Checklist for "Invalid for_each argument"

1. Look at what the map is keyed by. If it's an attribute that only exists
   after a resource is created (IDs, ARNs, generated names), that's the problem.
2. Move that attribute into the map values and key by something from your
   configuration.
3. For ACM, key by `dvo.domain_name`.
4. Apex plus wildcard? Filter to the apex entry so one resource owns the shared
   validation record.
5. Check the plan from an empty state, not just against existing state.
6. Validation stuck? Check that the domain is delegated to Route 53.
