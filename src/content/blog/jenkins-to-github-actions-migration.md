---
title: "Moving an organisation from Jenkins to GitHub Actions"
description: "Years of Groovy pipelines, then a move to GitHub Actions: inventory first, reusable workflows, OIDC instead of secrets, and runners on EKS."
date: 2026-11-22
tags: [github-actions, jenkins, ci-cd, oidc, migration]
draft: true
---

For most of my time at work, CI/CD meant Jenkins. Groovy pipelines, Job DSL
seeding the jobs, Jenkinsfiles in roughly 40 repositories, SonarQube wired in,
and at one point a full "Jenkins 2.0" rebuild to clean up what had grown over
the years. In 2026 I led the move to GitHub Actions. This is what that looked
like and what I'd tell anyone starting the same move.

## Start with an inventory, not a workflow

The temptation is to pick a repo and start writing YAML. I did the boring part
first: a list of every repo with a Jenkinsfile, and for each one what it
actually did.

For every pipeline I wrote down:

- what triggers it (push, PR, tag, schedule, manual)
- what it builds (container image, static site, package, Terraform)
- where it deploys and with which credentials
- which shared library functions it calls
- which agent labels it needs and why

That list did two things. It showed that most pipelines were variations of a
handful of patterns: build an image and push it, deploy to a container
service, run Terraform. And it showed the outliers early, the pipelines with
custom Groovy logic or agents with special tooling, so they didn't surprise us
halfway through.

The first wave was about 25 repos, chosen because they fit the common
patterns. The odd ones waited.

## Reusable workflows replace the shared library

In Jenkins, the shared library was where common logic lived. The GitHub
Actions equivalent is a reusable workflow: a workflow with an
`on: workflow_call` trigger that other repos call like a function.

I wrote a small set of builder workflows in a central repo, and each app repo
got a short caller:

```yaml
# .github/workflows/build.yml in an app repo
name: build
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    uses: my-org/ci-workflows/.github/workflows/build-image.yml@v1
    with:
      image-name: my-app
      dockerfile: Dockerfile
    permissions:
      id-token: write
      contents: read
```

The reusable side declares its inputs and does the work:

```yaml
# my-org/ci-workflows/.github/workflows/build-image.yml
on:
  workflow_call:
    inputs:
      image-name:
        type: string
        required: true
      dockerfile:
        type: string
        default: Dockerfile

jobs:
  build:
    runs-on: my-runner-set
    steps:
      - uses: actions/checkout@v4
      # authenticate, build, push ...
```

Those builder workflows ended up serving more than 15 repos. A fix in one place
reaches all of them, which is what the shared library promised, but with a
version tag you can pin to and a diff anyone can read. Pin callers to a tag or
a commit, not `@main`, so a change to the builder doesn't break every repo at
once.

## Secrets become OIDC

The biggest win wasn't speed. It was getting rid of long-lived cloud
credentials stored in CI.

GitHub Actions can issue a short-lived OIDC token per job. The cloud provider
trusts GitHub's issuer and exchanges the token for temporary credentials
scoped to a role. For AWS:

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/my-app-deploy
    aws-region: eu-west-1
```

And for GCP, through Workload Identity Federation:

```yaml
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
    service_account: my-app-deploy@my-project.iam.gserviceaccount.com
```

The job needs `permissions: id-token: write`, and the trust policy on the
cloud side should pin the repository and, for deploys, the branch or
environment. Every migrated repo gave us one less static key to rotate.

## Runners

GitHub-hosted runners work for a lot of jobs, but we needed two things they
don't give you by default: more control over machine size and access to
private resources inside our VPCs. So the runners are self-hosted on EKS using
Actions Runner Controller, with scale sets that spin up ephemeral runner pods
per job. I've written that setup up separately; the short version is that
`runs-on` points at a scale set name, and nothing sits idle between jobs.

## Run both, cut over per repo

We never had a big-bang switch. For each repo:

1. Add the GitHub Actions workflow alongside the Jenkinsfile.
2. Let both run on PRs for a while and compare the results.
3. Move deploys to Actions once the build matched.
4. Disable the Jenkins job, then remove the Jenkinsfile.

Running both doubles the noise for a short time, but it means any repo can go
back to Jenkins by re-enabling a job, and nobody had to stop shipping.

## Beyond builds

Once the basics worked, the same approach covered platform work that used to
be manual or lived in Jenkins:

- **Repo provisioning**: a workflow that creates a repo with the standard
  settings, branch protection and the caller workflows already in place.
- **Terraform**: `plan` on pull requests, with the output on the PR, and
  `apply` from a protected path, both using OIDC roles.

## What moved easily, and what didn't

**Easy:** plain build-test-push pipelines. A Jenkinsfile with a few `sh`
steps maps almost line for line to workflow steps. SonarQube scanning also
moved without trouble, since it's just another step.

**Harder: shared library logic.** Groovy can do anything, so over the years it
did. Some functions held real decision logic: which environment to deploy to
based on the branch, how to tag images, when to skip stages. Each of those had
to be pulled out and rewritten either as workflow inputs and conditions or as
a small script in the builder repo. Reading the Groovy carefully was the slow
part.

**Harder: long-lived agents.** Jenkins agents that ran for months had state
on them: cached tools, Docker layers, files someone put there by hand. Some
builds depended on that without anyone knowing. Ephemeral runners start
clean every time, so hidden dependencies showed up as failures. The fix was
always to make the dependency explicit, in the image or in a setup step.

**Harder: credentials.** Every credential in Jenkins had to be traced to what
used it. Cloud keys became OIDC roles. Things that genuinely need a secret,
like third-party API tokens, moved to GitHub secrets at the narrowest scope
that worked, environment over repo, repo over org.

## Lessons

- Inventory before you write YAML. Most pipelines are a few patterns; find the
  outliers early.
- Reusable workflows are the shared library, with versioning. Pin them.
- Treat the migration as a chance to delete static cloud credentials. OIDC is
  the part I'd do first if I did it again.
- Ephemeral runners expose every hidden dependency your old agents had.
  That's a feature.
- Run both systems in parallel and cut over repo by repo. Nobody should have to
  pause a release for a CI migration.
