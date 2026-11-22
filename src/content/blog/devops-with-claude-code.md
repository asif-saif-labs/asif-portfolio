---
title: "How I use Claude Code for day-to-day DevOps work"
description: "Slash commands, runbooks the agent follows, a work journal it keeps for me, and the rules that keep a human in charge of anything that matters."
date: 2026-11-22
tags: [ai, claude-code, devops, terraform, automation]
draft: false
---

Most of my DevOps day isn't hard. It's repetitive: pick up a ticket, read the
context, change some Terraform, open a PR, write up what happened, remember on
Monday what I did last week. I use Claude Code, Anthropic's agentic CLI, every
day for that layer of work. This post is how I've set it up, and the rules I
keep so it stays useful and safe.

## Slash commands for the jobs I repeat

Claude Code lets you save a prompt as a custom slash command: a Markdown file
with instructions, which you run by name. I have one for each job I do over
and over:

| Command | What it does |
|---|---|
| `/today` | starts the day: creates today's journal page, carries over open to-dos, shows what's logged so far |
| `/ticket` | picks up a ticket, reads it and the code it touches, and drafts the change, often a Terraform PR |
| `/incident` | traces the logs around an incident and drafts the findings |
| `/rca` | writes a root cause analysis from the incident notes in a fixed structure |
| `/commit` | writes the commit message and makes a signed commit with the right git identity for that folder |
| `/timesheet` | builds last week's timesheet from my journal and git history, and flags gaps |

The value isn't that each command is clever. It's that each one does the job
the same way every time. `/rca` always has the same sections. `/commit`
never signs a work commit with my personal email, because the identity comes
from which folder the repo is in, not from my memory.

## Runbooks the agent follows

The bigger win was writing my standards down as runbooks in Markdown, and
pointing the agent at them. A runbook is just the checklist I'd give a new
teammate. For example, my Terraform PR and apply standard says, in short:

```text
1. Make the change on a feature branch and run terraform plan.
2. I review the plan. Only the expected resources change.
3. Apply from the feature branch.
4. Validate with a targeted plan: the changed resources show no diff.
5. Then merge.
```

Because the runbook is written down, the agent follows it, and so do I on
days I'm tired. When I change how I want something done, I edit the runbook,
not my habits. A global instructions file tells the agent which runbook
applies to which kind of work.

## A journal it keeps for me

I keep a plain-text work journal, one file per day, managed by a small script.
The rule I gave the agent: when a piece of work is finished in a session, a
ticket updated, a PR opened, an apply done, a report delivered, log it to the
journal straight away, with the hours if I gave any.

```bash
journal did "Updated deploy role trust policy #terraform 1h"
```

That one habit replaced the Monday morning struggle to remember the previous
week. `/timesheet` reads the journal and the git log together, so work I
forgot to log still shows up as a commit, and gaps get flagged instead of
guessed.

The agent doesn't hand-edit the journal files. It only goes through the
script, so the format stays consistent and nothing gets overwritten.

## Jira and Confluence through MCP

Claude Code can talk to other tools through MCP (Model Context Protocol)
servers. With the Atlassian one connected, `/ticket` reads the ticket and its
comments itself, and `/rca` can draft straight into Confluence. I don't
copy and paste between a browser and a terminal any more.

Comments follow templates kept in my notes, so an acknowledgement or a
closing comment looks the same every time, whoever reads it.

## Subagents for research

Some questions need a lot of reading: where is this variable set across
several repos, which pipelines still use an old action version, what changed in this
module over the last month. For those, the main session starts read-only
subagents that search in parallel and come back with conclusions, not file
dumps. They can't write or deploy anything. The main session stays focused,
and I review a summary instead of scrolling through dozens of file reads.

## The rules that keep it safe

None of this works without clear limits. These are mine:

- **I approve anything outward-facing.** A comment on a ticket, a message, a
  PR description, a Confluence page: the agent drafts, I read, then it goes
  out. Nothing is posted in my name that I haven't seen.
- **I approve anything destructive.** Deletes, closes, force pushes, anything
  that can't be undone waits for me.
- **Plans before applies.** The agent can run `terraform plan` and explain it.
  I read the plan before any apply, every time, and the apply standard above
  is in the runbook it follows.
- **Secrets stay out of notes.** The journal, snippets and runbooks never hold
  credentials. Secrets live in a password manager or a separate secrets
  folder, and the agent is told so in its instructions.
- **Least privilege by default.** Read-only subagents for research. Write
  access only where the task needs it.
- **Everything is reviewable.** Changes land as commits and PRs, not as
  untracked edits on a server.

The agent is fast and doesn't get bored. It also states wrong things with
the same confidence as right ones. The rules are there so speed never skips
the review.

## If you want to try this

1. Pick the task you repeat most and turn it into one slash command.
2. Write your standard for it as a short Markdown runbook, and tell the agent
   to follow it.
3. Keep a journal the agent appends to, through a script, not free-form
   edits.
4. Connect your ticketing tool, read-only at first.
5. Decide up front what always needs your approval, and write that down too.
