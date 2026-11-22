// Everything personal lives here. Replace the TODO placeholders with real details.

export const profile = {
  name: "Asif Khan",
  handle: "asif",
  host: "aslabs",
  role: "DevOps Engineer", // TODO: your exact title
  location: "India", // TODO: city
  tagline: "I automate the boring parts of running software, then write about it.",
  bio: [
    "TODO: two or three sentences about what you do day to day: cloud infrastructure, CI/CD, Terraform, keeping things running.",
    "TODO: what you care about (reliability, cost, developer experience) and what you're learning right now.",
  ],
  links: {
    github: "https://github.com/asif3966",
    linkedin: "https://www.linkedin.com/in/TODO",
    email: "TODO@example.com",
    rss: "/rss.xml",
  },
};

// Rendered like `git log --oneline --graph`: newest first.
export const experience = [
  { year: "20XX–now", role: "DevOps Engineer", org: "TODO: company", note: "TODO: one line on scope and impact" },
  { year: "20XX–20XX", role: "TODO: previous role", org: "TODO: company", note: "TODO: one line" },
  { year: "20XX", role: "TODO: degree", org: "BITS Pilani", note: "Dissertation: AI-assisted Terraform drift detection" },
];

// Rendered like `terraform state list`.
export const skills = {
  cloud: ["aws.ec2", "aws.eks", "aws.s3", "aws.cloudfront", "aws.iam", "aws.route53", "aws.bedrock"],
  iac: ["terraform", "terraform.modules", "terraform.state"],
  cicd: ["github_actions", "oidc_federation"],
  containers: ["docker", "kubernetes", "helm"],
  languages: ["bash", "python", "hcl", "yaml"],
  observability: ["cloudwatch", "prometheus", "grafana"],
};
