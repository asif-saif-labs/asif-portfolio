#!/usr/bin/env node
// Draft a LinkedIn post for a blog post, let me edit it, then open LinkedIn's
// own composer with the text filled in. Nothing is posted by this script: the
// composer is the preview, and I click Post myself.
//
//   npm run linkedin                  list published posts
//   npm run linkedin -- <slug>        draft, edit, preview, open composer
//   npm run linkedin -- <slug> --print   draft only, print it (no editor, no browser)
//
// No API, no token. Drafts live in linkedin-drafts/ (gitignored).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BLOG_DIR = join(ROOT, "src/content/blog");
const DRAFT_DIR = join(ROOT, "linkedin-drafts");
const SHARED_LOG = join(DRAFT_DIR, "shared.json");
const SITE = readFileSync(join(ROOT, "astro.config.mjs"), "utf8").match(/site:\s*"([^"]+)"/)[1];
const LIMIT = 3000; // LinkedIn post character limit
const MAX_HASHTAGS = 5;
const COMPOSER = "https://www.linkedin.com/feed/?shareActive=true&text=";

// --- posts -------------------------------------------------------------------

// Just enough YAML for our frontmatter: scalars, quoted strings, [a, b] lists.
function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    value = value.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else if (value === "true" || value === "false") {
      data[key] = value === "true";
    } else {
      data[key] = unquote(value);
    }
  }
  return data;
}

function unquote(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function loadPosts() {
  return readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ slug: f.replace(/\.md$/, ""), ...parseFrontmatter(readFileSync(join(BLOG_DIR, f), "utf8")) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// "data-engineering" -> "#DataEngineering", "aws" -> "#AWS"
const UPPER = new Set(["aws", "gcp", "ecs", "eks", "gke", "iam", "kms", "waf", "rds", "s3", "ci", "cd", "ai", "llm", "sql", "oidc", "api", "dns", "cdn", "vpc", "mcp", "alb", "nlb", "acm", "arc", "sns", "sqs", "efs", "ebs", "ec2", "msk"]);
const SPECIAL = { devops: "DevOps", github: "GitHub", gitops: "GitOps", finops: "FinOps", mlops: "MLOps", postgresql: "PostgreSQL", bigquery: "BigQuery", cloudfront: "CloudFront", cloudwatch: "CloudWatch", javascript: "JavaScript", typescript: "TypeScript", argocd: "ArgoCD", litellm: "LiteLLM", nginx: "NGINX" };
function word(w) {
  const lower = w.toLowerCase();
  if (SPECIAL[lower]) return SPECIAL[lower];
  if (UPPER.has(lower)) return w.toUpperCase();
  return w[0].toUpperCase() + w.slice(1);
}
function hashtag(tag) {
  return "#" + tag.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word).join("");
}

function template(post) {
  const url = `${SITE}/blog/${post.slug}/`;
  const tags = (post.tags || []).slice(0, MAX_HASHTAGS).map(hashtag).join(" ");
  return [
    post.description,
    "",
    "What I learned:",
    "- ",
    "- ",
    "- ",
    "",
    `Full write-up: ${url}`,
    "",
    tags,
    "",
  ].join("\n");
}

// --- shared log --------------------------------------------------------------

const readShared = () => (existsSync(SHARED_LOG) ? JSON.parse(readFileSync(SHARED_LOG, "utf8")) : {});
function markShared(slug) {
  const log = readShared();
  log[slug] = new Date().toISOString().slice(0, 10);
  writeFileSync(SHARED_LOG, JSON.stringify(log, null, 2) + "\n");
}

// --- helpers -----------------------------------------------------------------

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase();
}

function edit(file) {
  const editor = process.env.LINKEDIN_EDITOR || "code --wait";
  const [cmd, ...args] = editor.split(" ");
  const r = spawnSync(cmd, [...args, file], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    console.error(`Could not run "${editor}". Edit ${file} yourself, then re-run with the same slug.`);
    process.exit(1);
  }
}

async function isLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

function open(url) {
  execFileSync("open", [url]);
}

function copy(text) {
  try {
    execFileSync("pbcopy", { input: text });
    return true;
  } catch {
    return false;
  }
}

// --- main --------------------------------------------------------------------

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const slug = args.find((a) => !a.startsWith("--"));
const posts = loadPosts();
const shared = readShared();

if (!slug) {
  console.log("Published posts (newest first):\n");
  for (const p of posts.filter((p) => !p.draft)) {
    const mark = shared[p.slug] ? `  [shared ${shared[p.slug]}]` : "";
    console.log(`  ${String(p.date).slice(0, 10)}  ${p.slug}${mark}`);
  }
  console.log("\nUsage: npm run linkedin -- <slug>");
  process.exit(0);
}

const post = posts.find((p) => p.slug === slug);
if (!post) {
  console.error(`No post "${slug}" in src/content/blog. Run "npm run linkedin" for the list.`);
  process.exit(1);
}
if (post.draft) {
  console.error(`"${slug}" is marked draft: true, so it isn't on the site. Publish it first.`);
  process.exit(1);
}

mkdirSync(DRAFT_DIR, { recursive: true });
const draftFile = join(DRAFT_DIR, `${slug}.txt`);
if (!existsSync(draftFile)) {
  writeFileSync(draftFile, template(post));
  console.log(`New draft: ${draftFile}`);
} else {
  console.log(`Using your existing draft: ${draftFile}`);
}

if (printOnly) {
  process.stdout.write("\n" + readFileSync(draftFile, "utf8"));
  process.exit(0);
}

if (shared[slug] && (await ask(`Already shared on ${shared[slug]}. Share again? [y/N] `)) !== "y") process.exit(0);

console.log("Opening the draft in your editor. Save and close it to continue.");
edit(draftFile);

const text = readFileSync(draftFile, "utf8").trim();
const emptyBullets = text.split("\n").filter((l) => /^-\s*$/.test(l)).length;

console.log("\n" + "-".repeat(60) + "\n" + text + "\n" + "-".repeat(60));
console.log(`${text.length} / ${LIMIT} characters`);
if (text.length > LIMIT) {
  console.error("Too long for LinkedIn. Shorten the draft and run again.");
  process.exit(1);
}
if (emptyBullets) console.warn(`Warning: ${emptyBullets} empty bullet line(s) still in the draft.`);

const url = `${SITE}/blog/${slug}/`;
if (!(await isLive(url))) {
  console.error(`${url} isn't reachable yet (not deployed?). Not opening LinkedIn.`);
  process.exit(1);
}

if ((await ask("Open the LinkedIn composer with this text? [y/N] ")) !== "y") {
  console.log(`Not opened. The draft stays in ${draftFile}.`);
  process.exit(0);
}

// Pre-filled composer. Also copy to the clipboard in case LinkedIn ignores the
// text parameter: then it's one paste into the empty composer.
const copied = copy(text);
open(COMPOSER + encodeURIComponent(text));
console.log(
  "Opened LinkedIn. Check the text and the link card, then click Post." +
    (copied ? "\nThe text is also on your clipboard if the composer opened empty." : ""),
);

if ((await ask("Did you post it? (records it in linkedin-drafts/shared.json) [y/N] ")) === "y") {
  markShared(slug);
  console.log("Recorded.");
}
