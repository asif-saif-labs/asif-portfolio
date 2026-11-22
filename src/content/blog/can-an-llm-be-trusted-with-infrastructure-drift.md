---
title: "Can an LLM be trusted with infrastructure drift? Lessons from my M.Tech dissertation"
description: "I built a Terraform drift detector with an optional AI layer. A small model under-rated 17 of 25 events; an escalate-only rule blocked every one."
date: 2026-11-22
tags: [terraform, aws, llm, security, drift-detection]
draft: false
---

For my M.Tech dissertation at BITS Pilani I built a tool that detects
infrastructure drift in AWS, decides how serious it is, and either fixes it or
asks a human. The obvious question from everyone was: why not let an LLM make
the call? I added one, gave it hard limits, and measured what it did. The
limits turned out to be the most important part.

## What the tool does

Drift is when live infrastructure no longer matches the Terraform code, like
a security group opened by hand. The pipeline is deliberately boring:

1. **Detect.** Terraform runs a refresh-only plan. Terraform is the authority
   on what changed; no model computes the diff.

   ```bash
   terraform plan -refresh-only -out=tfplan
   terraform show -json tfplan > plan.json
   ```

2. **Normalise.** A Python parser reads `resource_drift` from the plan JSON
   and turns it into one event per changed attribute, so a resource with three
   changed fields becomes three events.
3. **Filter provider noise.** Refresh-only plans report things that aren't
   real drift: attributes mirrored from another resource, nulls turning into
   provider defaults, volatile computed values. These are suppressed, but kept
   in the audit trail, never silently dropped.
4. **Classify.** Deterministic rules assign a category (network security,
   identity and access, data protection, resource configuration, tagging) and
   a severity, with a readable reason. For IAM, the rules diff the old and new
   policy documents and flag only wildcards, new principals or removed Deny
   statements that the change *introduced*.
5. **Route.** A small allow-list of low-risk tag changes goes to automatic
   remediation. Everything else goes to human approval.

Approvals happen in a Streamlit app, every decision goes into a SQLite audit
log, and it ships as a non-root Docker image with no credentials baked in.

## The AI layer, and its rules

The AI step is optional and pluggable: Amazon Bedrock was the designed target,
and it also supports a local model through Ollama, the Anthropic API, or any
OpenAI-compatible endpoint. Whatever the provider, the same three rules apply.

**It can only raise severity.** If the model rates an event higher than the
rules, with enough confidence, the severity goes up, and a tag change that
would have been auto-fixed goes to a human instead. If it rates an event
lower, the suggestion is ignored and shown to the reviewer. It can't send
anything to auto-remediation; only the rules and the tag allow-list can.

**It never applies changes.** It has no tools and no credentials. It returns
a schema-validated JSON object with severity, category, confidence, rationale
and a prompt-injection flag. Timeouts, errors and invalid output fall back to
the rules-only decision.

**It sees a redacted copy of one change.** Account IDs, ARNs, IPs, hostnames,
secrets, Terraform-sensitive values, tag values and free text are replaced or
removed before the call. The model doesn't get the plan, the state, the
resource address or the rule engine's verdict.

Tag values and descriptions are exactly where an attacker would hide
instructions, so instruction-like text is stripped and flagged, and a flag
forces human approval. An end-to-end test puts a tag on a resource telling
the model to rate an internet exposure "low". The instruction never reaches
the model, and even a model that obeyed it couldn't lower the critical
decision.

Simplified, the decision step looks like this:

```python
ESCALATION_CONFIDENCE = 0.7

def decide(rule, ai):
    severity, action = rule.severity, rule.action
    if ai is None or ai.status != "ok":
        return severity, action                      # rules only
    if rank(ai.severity) > rank(severity) and ai.confidence >= ESCALATION_CONFIDENCE:
        severity = ai.severity                       # escalate
        action = "human_approval"
    # a lower AI severity is recorded for the reviewer, never applied
    if ai.injection_suspected:
        action = "human_approval"
    return severity, action
```

I also wrote a STRIDE threat model for the whole system and 51 unit tests,
covering parsing, noise filtering, classification, the IAM diff, every
redaction category, schema validation, fallback and the escalate-only rules.

## How I tested it

I injected drift into live AWS: 15 scenarios across 9 services (EC2, S3, IAM,
ECS, VPC, RDS, ElastiCache, EKS and CloudFront). Each wave applied a clean
Terraform stack, checked a no-drift plan for false positives, made known
changes with the AWS CLI, ran the detector against labelled ground truth, and
destroyed the stack. Scenarios ranged from a tag change to a disabled S3
public access block and an IAM policy broadened to `Action: "*"`.

## Results

| Measure | Result |
|---|---|
| Drift detected | 15 / 15 |
| False positives on clean stacks | 0 |
| Provider-noise items suppressed | 11 |
| Detection time (Terraform refresh against live AWS) | about 5–7 s per wave |

There's a caveat I want to be upfront about. The mid-term rules got 14 of 15
severities right; they over-rated an IAM change that added one specific action
to a policy that already had a wildcard resource. I fixed that with the IAM
policy diff and the final rules got 15 of 15. But I tuned them on the same
scenarios, so that is **not a held-out result**. It shows the fix works, not
that the rules generalise. A larger held-out set is future work.

## What the model actually did

Bedrock wasn't available: my AWS account was new, and its model access was
restricted. So I ran the AI layer with a small local model, `qwen2.5:3b`
through Ollama, using the same redaction, schema and decision code.

Across the 25 actionable events in the live plans:

- **25 / 25** structured outputs were valid.
- The model **under-rated 17 of 25** events. That included S3 public access
  block changes, which the rules rate critical, rated low.
- It rated **0** events higher than the rules.
- The escalate-only rule blocked all 17, so the AI changed **0** final
  decisions.
- **0** account IDs, bucket names or tag values appeared in what was sent.

Used on its own, the model would have treated a public bucket as low
priority. The output was well-formed and wrong; valid JSON tells you nothing
about whether the judgement is right.

A larger model would probably agree with the rules more often, but a guardrail that only holds
when the model is good isn't a guardrail.

One early run happened before the model had loaded. Every event came back
with an error status, and the system still produced the full rules-only
result. It has no hard dependency on the AI.

## Takeaways

The answer to the title, for now: trust an LLM to add caution, not to remove
it.

- **Keep the authority deterministic.** Terraform owns the diff, rules own
  the decision. The model is an extra opinion.
- **Make it escalate-only.** A model that can only make things stricter can
  be wrong without causing harm.
- **Never give it the keys.** No tools, no credentials, no path to
  remediation.
- **Send it the least data.** One redacted change, no identifiers, no free
  text. Measure leaks; don't assume.
- **Treat infrastructure metadata as untrusted input.** Tags and descriptions
  are where prompt injection lives.
- **Fail closed to rules.** Timeouts and bad output should change nothing.
- **Be honest about your evaluation.** If you tuned on the test set, say so.
