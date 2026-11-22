---
title: "Locking Django /admin to office IPs with AWS WAF, while the API stays public"
description: "A WAF v2 rule that blocks /admin from outside the office, survives /ADMIN/ and /%61dmin/, and leaves the public API alone."
date: 2026-11-22
tags: [aws, waf, django, cloudfront, terraform]
draft: true
---

At work, a production Django backend serves a public API to a browser app, and
also exposes Django's own `/admin`. The API has to work from any network. The
admin should only load from office IPs. Security groups can't do that, because
they filter by IP, not by path, and the same load balancer serves both.

So it became a WAF problem: block `/admin` unless the request comes from an
office IP, allow everything else.

## The rule

The logic is one rule with three parts:

- the path is `/admin` exactly, or starts with `/admin/`
- **and** the source IP is **not** in the office IP set
- then **block**

The default action of the web ACL is **allow**, so the API is untouched.

Matching `/admin` exactly plus `/admin/` as a prefix, rather than just a
`/admin` prefix, matters. A bare prefix match would also block any future
path like `/admin-reports` on the API.

In Terraform (names and IPs are placeholders):

```hcl
resource "aws_wafv2_ip_set" "office" {
  name               = "office-ips"
  scope              = "REGIONAL" # or CLOUDFRONT, see below
  ip_address_version = "IPV4"
  addresses          = ["203.0.113.0/24"]
}

resource "aws_wafv2_web_acl" "backend" {
  name  = "my-app-backend"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "admin-office-only"
    priority = 1

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          or_statement {
            statement {
              byte_match_statement {
                search_string         = "/admin"
                positional_constraint = "EXACTLY"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "LOWERCASE"
                }
              }
            }
            statement {
              byte_match_statement {
                search_string         = "/admin/"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
        statement {
          not_statement {
            statement {
              ip_set_reference_statement {
                arn = aws_wafv2_ip_set.office.arn
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "admin-office-only"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "my-app-backend"
    sampled_requests_enabled   = true
  }
}
```

## Why the text transformations matter

A byte match is literal. Without transformations, `/admin/` is blocked and
these are not:

```text
/ADMIN/      different case
/%61dmin/    "a" percent-encoded as %61
```

The web server decodes `%61` back to `a`, so `/%61dmin/` reaches Django as
`/admin/`. Django's URL resolver is case-sensitive, so `/ADMIN/` would most
likely 404 anyway, but I didn't want the rule's correctness to depend on that.
`URL_DECODE` then `LOWERCASE`, in that order, normalises both before the
comparison.

I tested both from outside the office after the rollout, along with the plain
paths:

```bash
for p in /admin /admin/ /admin/login/ /ADMIN/ /%61dmin/ /api/v1/health/; do
  printf '%-18s %s\n' "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' "https://api.example.com$p")"
done
```

Off the office network, every admin variant should return `403` and the API
health endpoint `200`. From the office or VPN, `/admin/login/` should load.

One more thing worth knowing: ALB health checks don't go through WAF. If your
target group health check hits something under `/admin`, it keeps working.

## Which IP does WAF actually see?

This is the part that's easy to get wrong when CloudFront sits in front of the
ALB. WAF evaluates the source IP of the connection it's attached to:

| WAF attached to | Source IP it sees |
|---|---|
| CloudFront distribution (`scope = "CLOUDFRONT"`, created in us-east-1) | the viewer's IP |
| ALB (`scope = "REGIONAL"`), with traffic coming through CloudFront | a CloudFront edge IP |
| ALB, with clients hitting it directly | the client's IP |

So an office-IP rule on a regional WAF behind CloudFront blocks the office
too, because no request arrives from an office IP. The options:

- **Attach the WAF to CloudFront.** It sees the viewer IP directly.
- **Keep it on the ALB and use a forwarded IP config.** The
  `ip_set_reference_statement` accepts an `ip_set_forwarded_ip_config` block
  that reads the IP from a header like `X-Forwarded-For`. Be careful:
  clients can send their own `X-Forwarded-For`, and CloudFront appends to it
  rather than replacing it, so the wrong position in that header is
  client-controlled.
- **If clients reach the ALB directly**, a regional WAF on the ALB is the
  right place.

Also check whether the ALB is reachable without going through CloudFront. If
it is, a CloudFront-only WAF can be bypassed by calling the ALB's hostname.
Restricting the ALB's security group to CloudFront's origin-facing managed
prefix list closes that.

## Codifying the CloudFront changes

Some CloudFront settings in this setup had been changed by hand in the
console over time. Once the WAF work was done, I brought those changes into
the Terraform code and kept re-running the plan until it said:

```text
No changes. Your infrastructure matches the configuration.
```

Until it says that, the next person who runs `apply` for an unrelated change
quietly reverts whatever was done in the console. Drift in a distribution that
fronts production is not something to leave for later.

## Checklist

1. Block by path and IP in one rule; keep the web ACL default as allow.
2. Match `/admin` exactly and `/admin/` as a prefix.
3. Add `URL_DECODE` then `LOWERCASE` transformations.
4. Test `/ADMIN/` and `/%61dmin/` from outside, not only `/admin/`.
5. Decide where WAF is attached based on which IP it will actually see.
6. Make sure the origin can't be reached around the WAF.
7. Turn on metrics and sampled requests so you can see what's blocked.
8. Codify any console changes until `terraform plan` shows no changes.
