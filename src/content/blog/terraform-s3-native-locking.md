---
title: "Terraform state on S3 without a DynamoDB table"
description: "use_lockfile gives you state locking with just the S3 bucket. Here's the bootstrap I use."
date: 2026-11-21
tags: [terraform, aws, s3]
---

For years, a "proper" Terraform S3 backend meant two resources: a bucket for
the state and a DynamoDB table for the lock. Newer Terraform versions can lock
with S3 alone, using a lock file next to the state object.

## The backend block

```hcl
terraform {
  backend "s3" {
    bucket       = "my-tfstate-bucket"
    key          = "global/terraform.tfstate"
    region       = "ap-south-1"
    use_lockfile = true   # lock via S3, no DynamoDB table
    encrypt      = true
  }
}
```

While a plan or apply runs, Terraform writes `global/terraform.tfstate.tflock`
with a conditional write. A second run that tries to take the lock fails fast
instead of corrupting state.

## The bucket, done properly

The state bucket deserves more care than most buckets:

- **Versioning on**, so a bad apply can be rolled back to the previous state.
- **Encryption on**, and **all public access blocked**.
- **A TLS-only bucket policy**: deny any request where `aws:SecureTransport` is false.
- **`prevent_destroy`**, because deleting it orphans every stack.
- **Expire old versions** after 90 days to keep the bill near zero.

## The chicken-and-egg

The bucket can't store its own state before it exists. The way out:

1. Apply the bucket's stack with **local state**.
2. Add the `backend "s3"` block pointing at the new bucket.
3. Run `terraform init -migrate-state`. Terraform copies the local state into
   the bucket.
4. Run `terraform plan`: it should say **No changes**. Then delete the local
   state file.

That's the whole bootstrap. One bucket, no table, and every other stack in
the repo points at it with its own `key`.
