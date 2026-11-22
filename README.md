# asif-portfolio

Personal site and weekly DevOps blog for Asif Khan. Terminal-style, static,
hosted on AWS for a few rupees a month.

> Status: **planning**. This README is the plan; code comes next.

## Look and feel: "your shell, but a website"

- Dark terminal theme, monospace (JetBrains Mono), green/amber accents, a
  readable light mode for people who insist.
- Pages read like commands:
  - Home: `asif@aslabs:~$ whoami` with an ASCII banner and a blinking cursor.
  - Blog: `ls -lt ~/blog` (date, read time, tags as `--tag=terraform`).
  - Projects: `kubectl get projects -o wide` style table, with status pills.
  - Experience: `git log --oneline --graph` timeline.
  - Skills: `terraform state list` style.
  - Contact: `curl -X POST asif/contact` (links, no form to spam).
  - 404: `bash: /this-page: No such file or directory`.
- Easter eggs: press `:` for a tiny command palette (`help`, `ls`, `cd blog`,
  `theme light`, `sudo hire-me`).
- Fast and accessible: no JavaScript needed to read anything; good contrast,
  real headings, works with a keyboard and a screen reader.

## Tech stack

| Part | Choice | Why |
|---|---|---|
| Site generator | **Astro** | Static HTML, ships zero JS by default, Markdown/MDX blog posts, built-in syntax highlighting |
| Posts | Markdown in `src/content/blog/` | Write a post = add one `.md` file and open a PR |
| Code blocks | Shiki (built into Astro) | Terminal-accurate highlighting for HCL, YAML, bash, Python |
| Extras | RSS, sitemap, tags, read time, Open Graph images | Discoverable and shareable on LinkedIn/X |
| Comments (optional) | giscus (GitHub Discussions) | Free, no tracking, readers sign in with GitHub |
| Analytics (optional) | CloudFront standard logs or GoatCounter | Free, no cookie banner needed |

## Hosting: AWS, near-zero cost

```
GitHub (PR merged to main)
   │  GitHub Actions: build → test links → deploy
   │  (AWS access via OIDC, no stored keys)
   ▼
S3 bucket (private) ──► CloudFront (HTTPS, cache, security headers) ──► Route 53
                         asif.aslabs.co.in, cert from ACM (*.aslabs.co.in)
```

| Piece | Monthly cost |
|---|---|
| S3 (a few MB of HTML) | ~₹0 |
| CloudFront | free tier: 1 TB transfer + 10M requests/month |
| Route 53 | zone already paid in `aslabs-infra` (~$0.50) |
| ACM certificate | free (wildcard already in `aslabs-infra`) |
| **Total** | **~₹0–50** |

- Infra lives in `aslabs-infra/apps/portfolio/` (S3 with OAC, CloudFront,
  response headers policy, a CloudFront Function for clean URLs, DNS record,
  GitHub OIDC deploy role scoped to this repo's `main` branch).
- Until the `aslabs.co.in` KYC hold clears, the site works on its
  `*.cloudfront.net` URL.
- PRs get a build + link check; merging to `main` deploys in about a minute.

## Weekly blog workflow

1. `git checkout -b post/<slug>` and add `src/content/blog/<slug>.md`.
2. Open a PR: CI builds it and checks links.
3. Merge: it's live.

Post ideas to keep a weekly cadence: real incidents and how they were fixed,
Terraform patterns, cost-saving write-ups, "TIL" short notes, tool reviews,
and the build-in-public story of these apps (fintrack, aslabs-infra).

## Other things the site can do

- `/now`: what you're working on this month.
- `/uses`: your setup (Mac, terminal, tools).
- `/til`: short "today I learned" notes, lower effort than full posts.
- `/runbooks`: public versions of useful runbooks and cheat sheets.
- `/projects`: the aslabs apps, with live links as they ship.
- Resume: a downloadable PDF, generated from the same content.
- Talks/certifications, and later a newsletter from the RSS feed.

## Milestones

| # | What |
|---|---|
| 1 | Astro site: terminal theme, home, blog (2 sample posts), projects, about, 404, RSS |
| 2 | Infra in `aslabs-infra/apps/portfolio`, GitHub Actions deploy via OIDC |
| 3 | Live on CloudFront URL, then `asif.aslabs.co.in` once DNS is on Route 53 |
| 4 | First real weekly post; optional comments and analytics |
