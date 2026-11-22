---
title: "GitHub Actions can't assume your AWS role? Check the immutable subject claim"
description: "My OIDC trust policy matched the docs exactly and AWS still said no. The token's sub claim had numeric IDs in it."
date: 2026-11-22
tags: [aws, github-actions, oidc, iam, terraform]
---

I set up a deploy for this site the way I've done it many times: GitHub
Actions assumes an AWS role through OIDC, no access keys stored anywhere. The
first run failed after two minutes of retries:

```text
Run aws-actions/configure-aws-credentials@v4
Assuming role with OIDC
Assuming role with OIDC
...
Error: Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

The OIDC provider existed. The role existed. The repository variables were
right. The trust policy looked exactly like every example out there.

## The trust policy

The deploy job runs in a GitHub environment called `production`, which only
`main` can deploy to. So the role trusted exactly that:

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:my-org/my-repo:environment:production"
  }
}
```

`StringEquals` on the `sub` claim is the strict way to do it: no wildcards, so
only this repo's `production` jobs can get in. And that strictness is what
made the failure total. If the token's `sub` is off by a single character, AWS
refuses, and the error doesn't tell you what it actually received.

## What GitHub was actually sending

GitHub lets an org or repo customise the subject claim, so the first thing I
checked was the repo's OIDC settings:

```bash
gh api repos/my-org/my-repo/actions/oidc/customization/sub
```

```json
{
  "use_default": true,
  "use_immutable_subject": true,
  "sub_claim_prefix": "repo:my-org@12345678/my-repo@87654321"
}
```

There it was: `use_immutable_subject: true`. With it on, the subject doesn't
use names. It uses names **plus their numeric IDs**:

```text
expected:  repo:my-org/my-repo:environment:production
received:  repo:my-org@12345678/my-repo@87654321:environment:production
```

I never turned this on. The repo lives in a GitHub organisation I'd created a
few days earlier, and it was already set. If you've set up OIDC in an older
org and copy the same trust policy into a newer one, you can hit this without
changing a single line.

## Why the IDs are a good idea

Names can change hands. If an org or repo is renamed or deleted, someone else
can register the old name. A trust policy that only checks
`repo:my-org/my-repo` would trust whoever owns that name *now*. Numeric IDs
never move to a new owner, so a subject with IDs in it keeps pointing at the
repo you actually meant.

So the fix isn't to turn immutable subjects off. It's to trust them.

## The fix

I accept exactly two subjects, the name-based one and the ID-based one, both
for the `production` environment only. In Terraform:

```hcl
data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:my-org/my-repo:environment:production",
        "repo:my-org@12345678/my-repo@87654321:environment:production",
      ]
    }
  }
}
```

Keeping the name-based value means the role keeps working if the setting is
ever switched off. The plan was one in-place change to the role's trust
policy. I applied it, re-ran the workflow, and the deploy went green.

**Don't fix this with a broad wildcard.** It's tempting to write
`StringLike` with `repo:my-org*`, but that also matches `my-org-evil/anything`.
If you need a wildcard, keep it as narrow as possible and keep the environment
or branch in the pattern.

## Seeing the real claim yourself

The `gh api` call tells you the format. To see the exact `sub` a workflow
gets, print just that claim from inside the job:

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - name: Show OIDC subject (debug only)
    uses: actions/github-script@v7
    with:
      script: |
        const token = await core.getIDToken("sts.amazonaws.com");
        const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        core.info(`sub: ${claims.sub}`);
```

Print the `sub` claim only, never the token itself: the token is a
credential. Remove the step once you're done.

The shape of `sub` also changes with how the job runs, so match the case your
deploy actually uses:

| Job runs… | `sub` ends with |
|---|---|
| in an environment | `:environment:<name>` |
| on a branch, no environment | `:ref:refs/heads/<branch>` |
| for a pull request | `:pull_request` |

## Checklist for "Not authorized to perform sts:AssumeRoleWithWebIdentity"

1. The job has `permissions: id-token: write`.
2. The OIDC provider exists for `token.actions.githubusercontent.com`, with
   audience `sts.amazonaws.com`.
3. The role ARN in the workflow is the one you think it is.
4. Run `gh api repos/OWNER/REPO/actions/oidc/customization/sub`. If
   `use_immutable_subject` is `true`, your trust policy needs the `@id` form.
5. Environment, branch or pull request: does the end of the `sub` in your policy
   match how the job runs?
6. Still stuck? Print the `sub` claim with the step above and compare it
   character by character.

Step 4 is the one I'd never have guessed. It's now the first thing I check.
