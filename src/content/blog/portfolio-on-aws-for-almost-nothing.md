---
title: "Running this site on AWS for almost nothing"
description: "How this site is built, tested and deployed: Astro, S3, CloudFront, GitHub Actions with OIDC, and Terraform. The only fixed cost is about $0.50 a month."
date: 2026-11-22
tags: [aws, cloudfront, github-actions, terraform, cost]
draft: false
---

I wanted a blog that I own end to end, on the same tools I use at work, and
that costs close to nothing to run. No server, no container, no database.
This post is the whole setup, from a Markdown file to a page on a CloudFront
edge.

## The site: static HTML from Astro

The site is built with Astro. It renders everything to static HTML at build
time and ships no JavaScript unless a page asks for it. A blog post is one
Markdown file:

```text
src/content/blog/<slug>.md
```

with `title`, `description`, `date` and `tags` in the frontmatter. `npm run
build` writes the whole site to `dist/`. CSS and JS end up in `dist/_astro/`
with a content hash in each file name, which matters for caching later.

## Two repos

| Repo | What |
|---|---|
| `my-site` | Astro code, posts, GitHub Actions workflows |
| `my-infra` | Terraform for the AWS account |

Terraform builds the platform. The site repo only ever uploads files and
invalidates the cache. It can't change the bucket, the distribution or DNS.

## Terraform: one folder, one state

The infra repo is split by blast radius:

| Folder | What |
|---|---|
| `bootstrap/` | the S3 bucket that holds Terraform state |
| `global/` | Route 53 zone, wildcard ACM cert, GitHub OIDC provider, budget |
| `apps/portfolio/` | this site, using a reusable `static-site` module |
| `modules/static-site/` | private S3 + CloudFront + DNS + deploy role |

Each folder has its own key in the state bucket, with S3-native locking. Apps
read shared values such as the zone ID and certificate ARN from `global/`
through `terraform_remote_state`, never the other way round. Applying the site
can add its own DNS records, but it can't change or delete the zone.

## CI on every pull request

Posts go through a pull request like any other change. `ci.yml` builds the
site and checks that internal links resolve:

```yaml
- run: npm ci
- run: npm run build

- name: Check internal links
  uses: lycheeverse/lychee-action@v2
  with:
    args: --offline --no-progress --root-dir "${{ github.workspace }}/dist" "dist/**/*.html"
    fail: true
```

`--offline` means lychee only checks links inside `dist/`. External sites
being slow or down won't fail my build, but a broken link to my own post will.

## Deploy on merge to main

`deploy.yml` runs on every push to `main`. It builds, assumes an AWS role,
uploads and invalidates.

The upload is split so each kind of file gets the right cache header. Hashed
assets never change under the same name, so they're cached for a year:

```bash
aws s3 sync dist/_astro "s3://$SITE_BUCKET/_astro" \
  --cache-control "public, max-age=31536000, immutable"
```

Pages keep the same URL between deploys, so they're always revalidated:

```bash
aws s3 sync dist "s3://$SITE_BUCKET" --delete \
  --exclude "_astro/*" \
  --cache-control "public, max-age=0, must-revalidate"
```

The order is deliberate. New assets go up first, so a page from this deploy
never points to a file that isn't there yet. A last pass deletes hashed assets
the new build no longer uses:

```bash
aws s3 sync dist/_astro "s3://$SITE_BUCKET/_astro" --delete --size-only
```

Then one invalidation clears CloudFront's copy of the pages:

```bash
aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_ID" --paths "/*" \
  --query 'Invalidation.Id' --output text
```

The workflow uses `concurrency` with `cancel-in-progress: false`, so two quick
merges deploy one after the other instead of cancelling a deploy half-way
through a sync.

## No AWS keys in GitHub

The deploy job gets short-lived credentials through GitHub's OIDC provider.
The workflow needs `id-token: write` and runs in a GitHub environment:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    environment:
      name: production
```

The `production` environment only allows `main` to deploy. The IAM role trusts
exactly that environment of exactly this repo:

```text
repo:my-org/my-site:environment:production
```

So a workflow on a feature branch, or in a pull request, can't assume the
role at all. And the role itself can only list and write the one bucket and
create invalidations on the one distribution. The bucket name, distribution ID
and role ARN are plain repository variables, copied from `terraform output`.
They're not secrets.

## What it costs

| Piece | Monthly cost |
|---|---|
| S3 | a few MB of HTML and assets; negligible |
| CloudFront | free tier covers 1 TB of transfer and 10 million requests a month |
| Route 53 hosted zone | about $0.50 |
| ACM certificate | free |

The hosted zone is the only fixed cost, and it's shared: every other
subdomain I add to the domain uses the same zone and the same wildcard
certificate. The domain registration is separate and paid yearly at the
registrar.

A personal blog should stay well inside the CloudFront free tier. The risk isn't the
normal bill, it's the abnormal one: a mistake, a loop, something I forgot to
turn off. So `global/` has an AWS Budget of $10 a month for the whole account.
It emails me when actual spend passes 80% of that, and when the forecast goes
over 100%.

```hcl
resource "aws_budgets_budget" "monthly" {
  name         = "monthly"
  budget_type  = "COST"
  limit_amount = "10"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = ["me@example.com"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = ["me@example.com"]
  }
}
```

A budget doesn't stop spending. It tells you early, which for a personal
account is what you need.

## What I'd keep for any static site

1. Static build, with hashed asset names.
2. Private bucket behind CloudFront, no public website hosting.
3. Two cache policies in the upload: immutable for hashed assets, revalidate
   for pages.
4. A link check on every pull request.
5. OIDC role scoped to one repo and one environment, which only `main` can use.
6. Terraform split so the site can't break DNS or state.
7. A budget alert before the first deploy, not after the first surprise.
