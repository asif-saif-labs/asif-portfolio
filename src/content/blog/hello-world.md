---
title: "hello, world: why this blog exists"
description: "A weekly log of DevOps work: what broke, what fixed it, and what it cost."
date: 2026-11-22
tags: [meta, aws, astro]
---

Every week I fix something, automate something, or learn why something was
built the way it was. Most of that disappears into chat threads and terminal
history. This blog is where it goes instead.

## What to expect

- **Real problems.** Incidents, migrations and the odd 2 a.m. page, with the
  commands that actually worked.
- **Terraform and AWS patterns** I use day to day.
- **Cost write-ups.** What things cost, and what made them cheaper.
- **Build in public.** The side projects I'm building, from the first
  `terraform apply` onwards.

## How this site runs

The site is static HTML built with [Astro](https://astro.build). Each post is
one Markdown file. Merging a pull request to `main` runs a GitHub Actions
workflow that builds the site, syncs it to a private S3 bucket and invalidates
CloudFront:

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}   # OIDC, no stored keys
    aws-region: ap-south-1
- run: aws s3 sync dist/ "s3://$BUCKET" --delete
- run: aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*"
```

The whole thing costs a few rupees a month, mostly the Route 53 hosted zone.

Press <kbd>:</kbd> anywhere on the site if you're curious.
