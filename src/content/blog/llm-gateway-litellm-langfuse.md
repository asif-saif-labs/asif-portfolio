---
title: "Running an LLM gateway and observability for internal AI products"
description: "Why internal AI products at work call models through a LiteLLM gateway, how Langfuse traces them, and what keeps provider keys out of apps."
date: 2026-11-22
tags: [llm, litellm, langfuse, gke, security]
draft: false
---

Since 2022, I've been running the infrastructure behind internal AI products
at work. It started with a simple API gateway in front of OpenAI. Today it's
an LLM gateway on LiteLLM that fronts several providers, an MCP gateway,
Langfuse for tracing, and GPU workloads on Kubernetes. This post is about why
the gateway exists, how we observe what goes through it, and what I've
learned operating it.

## Why a gateway at all

The first AI feature is easy: an app gets an API key and calls the provider.
The trouble starts with the second and third. Every app has its own key, its
own retry logic, its own idea of which model to use, and no one can answer
simple questions like "how much did we spend on this product last week?"

A gateway puts one service between every app and every provider. That gives
you one place for:

- **Keys.** Provider keys live in the gateway only. Apps get their own
  gateway keys, which you can scope, rotate and revoke without touching a
  provider account.
- **Routing.** Apps ask for a model name; the gateway decides which provider
  and deployment serves it. Switching providers or adding a fallback is a
  config change, not an app release.
- **Budgets and limits.** Spend and rate limits per key or team, enforced
  before the request reaches the provider.
- **Logging.** Every request passes through one point, so every request can be
  traced.

Our first version, the API gateway in front of OpenAI, did the key part
well. As products started using more than one provider, it made sense to
move to a gateway built for that.

## LiteLLM as the gateway

LiteLLM's proxy exposes an OpenAI-compatible API and translates to many
providers behind it. Apps keep using an OpenAI client and point it at the
gateway:

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://llm-gateway.example.com",
    api_key=os.environ["GATEWAY_KEY"],  # a gateway key, not a provider key
)
```

The models are defined in the proxy config. An illustrative version:

```yaml
model_list:
  - model_name: chat-default
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: chat-default
    litellm_params:
      model: azure/my-gpt-4o-deployment
      api_base: os.environ/AZURE_API_BASE
      api_key: os.environ/AZURE_API_KEY

litellm_settings:
  success_callback: ["langfuse"]
  failure_callback: ["langfuse"]
```

Two entries with the same `model_name` give the router two deployments to
balance across. Apps ask for `chat-default` and never see which provider
answered.

The `os.environ/` syntax means provider keys come from the environment,
which on Kubernetes means a secret, populated from a secret manager. They are
never in the config file or the repo.

LiteLLM also proxies realtime endpoints, which matters for voice-style
products that hold a WebSocket open instead of making a single request.
Those connections are long-lived, so check the idle timeouts on every load
balancer and proxy in the path; defaults tuned for short HTTP requests will
cut them off.

## Langfuse for traces and cost

Logs tell you a request happened. LLM products need more: the prompt, the
response, token counts, latency, cost, and how calls group into a single user
interaction. That's what Langfuse is for.

We run Langfuse on GKE. Recent Langfuse versions need more than a single
database: Postgres for transactional data, ClickHouse for traces and
observations, Redis for queueing, and object storage for event payloads.
ClickHouse is the part that needs the most care. It's where the volume lands,
so give it fast persistent disks and watch its storage growth from day one.

With the gateway sending traces to Langfuse, every product gets tracing
without adding anything to its own code. Products that want richer traces,
such as nesting gateway calls under their own spans, can use the Langfuse SDK
on top.

## Security: no provider keys in apps

The security model is simple to state:

- **Apps never hold provider keys.** Only the gateway does. A leaked app key
  is a gateway key, which you can revoke in one place, with a budget limiting
  the damage in the meantime.
- **Network restrictions.** Internal tools don't need to be on the open
  internet. Our MCP gateway, which gives AI agents access to internal tools,
  sits behind a load balancer restricted to known networks. That's the right
  default for anything that can act on internal systems.
- **SSO for humans.** People reach the admin and observability UIs through
  Okta, not shared passwords, so access follows the identity provider and
  leaving the company removes it.
- **Prompts are data.** Traces contain whatever users typed. Treat Langfuse
  like any system holding user data: access control, retention, and care about
  who can export from it.

## Operating tips

- **Keep the gateway stateless and run more than one replica.** Every AI
  feature depends on it; it's now a critical path.
- **Health checks should not call the providers.** A provider outage shouldn't
  make Kubernetes restart your gateway pods.
- **Pin the gateway version and read the changelog.** LiteLLM moves fast, and
  model and provider support changes between releases.
- **Use model aliases.** Apps that ask for `chat-default` can be moved to a
  new model by changing one line of config.
- **Separate GPU workloads.** Self-hosted models on GPUs belong in their own
  node pool with taints, so ordinary pods don't land on expensive nodes.
- **Check the timeouts end to end.** LLM calls are slow, streaming responses
  are long, and realtime sessions are longer. Every hop needs a timeout that
  fits.

## Lessons

- Put a gateway in front of LLM providers before the second product needs
  one. Retrofitting it means chasing keys across every app.
- Keep provider keys in exactly one place.
- Tracing belongs in the platform, not in each product.
- Anything that lets an AI agent act on internal systems should not be
  publicly reachable.
