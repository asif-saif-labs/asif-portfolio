// Rendered like `kubectl get projects -o wide`. Status mirrors the aslabs apps tracker.

export type Project = {
  name: string;
  status: "Running" | "Pending" | "Building" | "Completed";
  stack: string;
  description: string;
  url?: string;
  repo?: string;
};

export const projects: Project[] = [
  {
    name: "asif-portfolio",
    status: "Running",
    stack: "astro, s3, cloudfront, gh-actions",
    description: "This site. Static, terminal-themed, deployed on every merge.",
    repo: "https://github.com/asif-saif-labs/asif-portfolio",
  },
  {
    name: "fintrack",
    status: "Building",
    stack: "django, react, postgres, claude",
    description: "Personal finance manager: reads bank and card statements, categorises, budgets.",
  },
  {
    name: "aslabs-infra",
    status: "Building",
    stack: "terraform, aws",
    description: "Terraform for every app: state, DNS, certificates, OIDC deploy roles, budgets.",
  },
  {
    name: "tf-drift-detector",
    status: "Completed",
    stack: "python, terraform, bedrock",
    description: "Dissertation: AI-assisted Terraform drift detection with tags-only remediation.",
  },
  {
    name: "mosque-app",
    status: "Pending",
    stack: "django, react",
    description: "Built with my brother. Details soon.",
  },
];
