// Everything personal lives here. Public: keep client names and internal
// product names out of this file.

export const profile = {
  name: "Asif Khan",
  handle: "asif",
  host: "aslabs",
  role: "Senior DevOps Engineer",
  location: "Bengaluru, India",
  tagline: "I turn `It works on my machine` into `It works in production`.",
  // Home page: one short paragraph.
  summary:
    "Senior DevOps Engineer in Bengaluru with 4.5+ years on AWS, GCP, Terraform and CI/CD. These days I build the infrastructure under AI products, and I write weekly about what broke and how I fixed it.",
  // About page: the longer version.
  bio: [
    "I'm a Senior DevOps Engineer in Bengaluru with 4.5+ years running cloud infrastructure for a marketing-technology agency: dozens of client environments across AWS and GCP, nearly 1,800 Terraform commits, and the CI/CD behind them, from Jenkins pipelines to an org-wide move to GitHub Actions.",
    "Lately I build the platform under AI products: LLM gateways, observability with Langfuse, GPU workloads and Kubernetes on EKS and GKE. I care about infrastructure that's secure by default, cheap to run and boring to deploy.",
    "I finished an M.Tech at BITS Pilani with a dissertation on AI-assisted Terraform drift detection. Outside work I build side projects on the same stack, and this blog is where I write down the problems worth remembering.",
  ],
  links: {
    github: "https://github.com/asif3966",
    linkedin: "https://www.linkedin.com/in/asif-ali-khan-bba890176/",
    email: "asifdevops3966@gmail.com",
    rss: "/rss.xml",
  },
};

// Rendered like `cat /proc/career`. Approximate, from GitHub and Jira history.
export const stats = [
  ["years_in_devops", "4.5+"],
  ["pull_requests", "~1,780"],
  ["terraform_commits", "~1,770"],
  ["pipeline_commits", "~1,500"],
  ["tickets_delivered", "~1,400"],
  ["clouds", "aws, gcp"],
];

// Rendered like `git log --oneline --graph`: newest first.
export type Role = { years: string; title: string; org: string; highlights: string[] };

export const experience: Role[] = [
  {
    years: "Mar 2025 – now",
    title: "Senior Associate DevOps",
    org: "Gale Creative Agencies",
    highlights: [
      "Led the move from Jenkins to GitHub Actions, with self-hosted runners on EKS (ARC) and keyless OIDC to AWS and GCP.",
      "Build and run the infrastructure for AI products: LLM gateway (LiteLLM), MCP gateway, Langfuse, and a media-AI platform on GKE with Argo CD.",
      "Moved a product off an out-of-support EKS version to ECS, removing $744/month in extended-support charges; moved Airflow to ECS and 3.2.",
      "Security: Okta and Keycloak as code, WAF admin lockdown, Qualys remediation, an nginx CVE inventory across 40+ AWS accounts.",
      "Quarterly cost reviews across ~10 AWS accounts; wrote the team's Terraform PR standard and NOC runbooks.",
    ],
  },
  {
    years: "Aug 2023 – Mar 2025",
    title: "Associate DevOps",
    org: "Gale Creative Agencies",
    highlights: [
      "Built full AWS stacks for new products and client launches (ECS, MSK, WAF, Lambda, Redis), plus a repeatable new-client production setup used ~10 times.",
      "Infrastructure for an internal AI platform: GPU instances, container-image Lambdas, Redshift Serverless per client, KMS envelope encryption, a DR test.",
      "Rolled out Jenkins 2.0 and SonarQube 2.0 across repositories, with build-failure alerts.",
      "Moved services from EC2 and EKS to ECS; ran Airflow upgrades across client data pipelines.",
    ],
  },
  {
    years: "Feb 2022 – Aug 2023",
    title: "Junior Associate DevOps",
    org: "Gale Creative Agencies",
    highlights: [
      "Migrated an application's environments to EKS, with shared ingress, SSM-based config and RDS Serverless.",
      "Moved application secrets and config to SSM Parameter Store; automated database backups.",
      "Set up self-hosted Sentry and ELK, and rolled Grafana monitoring out to 6 client AWS accounts.",
      "Upgraded Airflow for 4 client data pipelines; cost cleanups such as a Lambda that pauses idle RDS.",
    ],
  },
];

export const education = [
  {
    years: "2024 – 2026",
    title: "M.Tech, Computing Systems and Infrastructure",
    org: "BITS Pilani",
    note: "Dissertation: automated detection, classification and remediation of infrastructure drift in IaC. A Python engine reads Terraform refresh-only plans, classifies each drift and routes it to an automatic tag fix or human approval; an optional AI layer (Amazon Bedrock) may only raise severity and only sees redacted data. Evaluated on 15 drifts injected into live AWS: 15/15 detected, 0 false positives.",
  },
  {
    years: "2015 – 2019",
    title: "B.Tech, Electrical Engineering",
    org: "Techno India Salt Lake (MAKAUT)",
    note: "",
  },
];

// Rendered like `terraform state list`. Ordered by depth of experience.
export const skills: Record<string, string[]> = {
  aws: ["ecs", "ec2", "lambda", "vpc", "alb", "cloudfront", "route53", "waf", "iam", "kms", "rds_aurora", "redshift", "elasticache", "s3", "msk", "cloudwatch", "bedrock"],
  gcp: ["gke", "cloud_run", "composer", "bigquery", "artifact_registry", "secret_manager", "workload_identity"],
  iac: ["terraform", "terraform_okta", "cloudformation"],
  cicd: ["github_actions", "arc_runners", "jenkins", "sonarqube", "argo_cd", "oidc"],
  containers: ["docker", "eks", "gke", "karpenter", "helm", "kustomize"],
  data: ["airflow", "celery", "kafka", "redshift", "bigquery", "glue"],
  observability: ["grafana", "prometheus", "loki", "cloudwatch", "sentry", "langfuse"],
  security: ["okta", "keycloak", "waf", "kms", "qualys", "cve_remediation"],
  ai_platform: ["litellm", "mcp_gateway", "langfuse", "gpu_workloads", "bedrock"],
  languages: ["bash", "python", "sql", "hcl", "yaml", "groovy"],
};
