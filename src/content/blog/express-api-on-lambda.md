---
title: "An Express API on Lambda that costs nothing when nobody's using it"
description: "Moving a small Node.js API from an always-on container to Lambda with the Web Adapter, behind CloudFront and WAF. The setup, the cost, and five things that tripped me up."
date: 2026-11-26
tags: [aws, lambda, serverless, api-gateway, cloudfront, cost]
---

Most internal tools are idle most of the time. A browser extension and a
small admin console get a burst of requests in the morning, a few during the
day, and nothing overnight or at weekends. Running them on an always-on
container means paying for 730 hours a month to serve maybe a few thousand
requests.

I recently deployed one of these, a Node.js (Express) API with a Postgres
database, on AWS Lambda instead. The app code didn't change. Here's the
setup, what it costs, and what tripped me up on the way.

## The shape of it

```text
Users ── HTTPS ──> CloudFront + WAF (edge)
                       │  adds a secret X-Origin-Verify header
                       v
                 API Gateway (REST, regional) + WAF (origin lock)
                       │
                       v
                 Lambda (Node.js + Lambda Web Adapter), private subnets
                       │
          ┌────────────┼──────────────┐
          v            v              v
   Secrets Manager   Postgres      Identity provider (OIDC)
```

- **Lambda Web Adapter** is the piece that makes this painless. It's an AWS
  Lambda layer that starts your normal web server and turns Lambda events into
  plain HTTP requests on a local port. The Express app still calls
  `app.listen(8080)`. No `serverless-http` wrapper, no handler rewrite, and
  the same code runs locally with `node src/index.js`.
- **API Gateway** proxies every path (`ANY /` and `ANY /{proxy+}`) to the
  function.
- **CloudFront** gives a stable custom domain and the edge WAF (managed rules
  and a per-IP rate limit). It doesn't cache anything; it's there for the
  domain and the WAF.
- **A regional WAF on the API stage** blocks every request that doesn't carry
  a secret header CloudFront adds. Without it, anyone who finds the
  `execute-api` URL can skip the edge WAF entirely.
- **Lambda in private subnets** so it can reach the database, with outbound
  traffic through the existing NAT gateway.

The Lambda settings that matter:

```hcl
handler = "run.sh"   # a 2-line script: exec node src/lambda.js
layers  = [local.web_adapter_layer_arn]

environment {
  variables = {
    AWS_LAMBDA_EXEC_WRAPPER      = "/opt/bootstrap"
    AWS_LWA_PORT                 = "8080"
    AWS_LWA_READINESS_CHECK_PATH = "/healthz"
    AWS_LWA_ASYNC_INIT           = "true"
  }
}

reserved_concurrent_executions = 10
```

## Secrets and the database

The function reads one Secrets Manager secret at cold start, before the app
loads, and puts its keys into `process.env`:

```js
const { SecretString } = await new SecretsManagerClient({}).send(
  new GetSecretValueCommand({ SecretId: process.env.APP_SECRET_ARN })
);
Object.assign(process.env, JSON.parse(SecretString));
await import("./index.js");
```

So no secret sits in a Lambda environment variable, in Terraform state or in
GitHub.

The database is the part that needs thought. Each Lambda instance holds its
own connection pool, so the worst case is *concurrency × pool size*. I capped
the function at 10 concurrent instances and the pool at 2, so it can never
open more than 20 connections, whatever the traffic does. That's also a cost
and abuse cap.

The app gets its own database and its own login role on an existing cluster.
A new RDS instance just for this would have cost more than everything else
put together and undone the point of the exercise.

## Deploys

The infrastructure lives in Terraform. The app repo's workflow only ships
code:

1. Build `lambda.zip`.
2. Assume an AWS role with GitHub OIDC (no stored keys).
3. Upload the zip to S3 and run `aws lambda update-function-code`, then
   `aws lambda wait function-updated-v2`.
4. Invalidate CloudFront.
5. Smoke test: `curl` the `/healthz` endpoint, which runs `SELECT 1` against
   the database. If that passes, the secret, network and database user all
   work.

Terraform ignores the function's code hash, so a release never shows up as
drift.

## What it costs

For a low-traffic internal tool, at roughly on-demand prices in a US region:

| Item | Lambda setup | Always-on container |
|---|---|---|
| Compute | ~$0 (inside the Lambda free tier at a few thousand requests a day) | ~$18/month (0.5 vCPU, 1 GB, running 24/7) |
| Load balancer or API front | ~$0.01 (API Gateway, per request) | ~$17/month (a dedicated load balancer) |
| Secret, logs, CloudFront | ~$1–2/month | about the same |
| WAF | ~$12–16/month (two web ACLs) | ~$6–8/month (one) |

The WAF ends up being the largest line. If a tool only needs to be reachable
from the office or a VPN, drop the edge WAF and keep only the origin lock, and
the whole thing is close to free. If the container would have shared an
existing load balancer, the gap is smaller, but the compute saving remains.

It isn't the right fit for everything. API Gateway caps a request at
**29 seconds** and **10 MB**. A cold start adds 1–3 seconds to the first
request after the app has been idle. Long-running jobs, websockets and
anything that streams large files belong on a container. But for small CRUD
APIs, admin consoles, webhooks and tools a team uses a few times a day, it's
hard to beat.

## Five things that tripped me up

**1. A placeholder that returns 5xx looks like a timeout.** Terraform created
the function with a placeholder app that answered `503 not deployed` on every
path. Every request then took 29 seconds and ended in
`{"message": "Endpoint request timed out"}`. The Web Adapter treats any 5xx
from the readiness path as "not ready yet" and keeps waiting, so API Gateway
gives up first. Make the placeholder's `/healthz` return 200.

**2. An old provider can't create the runtime you want.** The Terraform stack
was pinned to an older AWS provider that didn't know the newest Node.js
runtime. I created the function on a runtime the provider accepted, put
`runtime` in `ignore_changes`, and switched it once in the console before the
first deploy. Write that down, or the next person will wonder why Terraform
and the console disagree.

**3. The deploy role refused the GitHub token.** The organisation uses
GitHub's immutable OIDC subject, so the token's `sub` was
`repo:org@<id>/repo@<id>:environment:production`, not the name-based form my
trust policy expected. I've written about this one before:
[GitHub Actions can't assume your AWS role?](/blog/github-oidc-immutable-subject/)

**4. The identity provider wants the redirect URI exactly.** The admin
console sends `https://<domain>/admin/` with a trailing slash. The OIDC app
had no entry for the new domain yet and returned a 400 saying the redirect
URI wasn't registered. A quick way to check without a browser:

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://<idp>/oauth2/v1/authorize?client_id=<id>&response_type=code&scope=openid&redirect_uri=<url-encoded>&state=x&nonce=x&code_challenge=<challenge>&code_challenge_method=S256"
```

302 means the URI is accepted; 400 means it isn't.

**5. CloudFront and API Gateway can't both own the hostname.** My first
version used an API Gateway custom domain. Moving to CloudFront meant removing
that domain first, because an alias can only sit on one distribution. I did
it in two applies: remove the custom domain and switch the API to regional,
then add CloudFront, the WAFs and the origin lock. Nothing pointed at the
domain yet, so there was no traffic to protect.

## Would I do it again?

Yes, for this kind of app. It took a couple of working days end
to end, most of it on edge security and the gotchas above, not on Lambda
itself. The next one will be quicker, since the Terraform module and the
deploy workflow are reusable as they are.

If you have a small API sitting on a container that's idle most of the day,
it's worth a look.
