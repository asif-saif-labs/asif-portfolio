---
title: "Terraform state on S3 without a DynamoDB table"
description: "The S3 backend can lock state with a lock file next to the state object. Here's my state bucket, and how it stores its own state."
date: 2026-11-22
tags: [terraform, aws, s3, iam]
draft: false
---

Every Terraform setup I'd built had the same pair: an S3 bucket for state and
a DynamoDB table for locking. For the infrastructure behind this site I
dropped the table. The S3 backend can now lock state on its own, with a lock
file stored in the same bucket.

## The backend block

Every stack in the repo has a backend like this:

```hcl
terraform {
  backend "s3" {
    bucket       = "my-tfstate-123456789012"
    key          = "global/terraform.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
    encrypt      = true
  }
}
```

`use_lockfile = true` is the whole change. When a run needs the lock,
Terraform writes a lock object next to the state, named after the key with
`.tflock` on the end:

```text
global/terraform.tfstate
global/terraform.tfstate.tflock
```

If another run already holds it, you get the familiar "Error acquiring the
state lock" with the lock info, exactly as with DynamoDB. When the run
finishes, the lock file is removed.

No table to create, no table to pay for, no second resource to keep in step
with the bucket. The older DynamoDB-based locking is still there if you need
it, but for a new setup I don't see a reason to start with it.

## One bucket, one key per stack

The repo is split into stacks, each with its own state:

| Folder | State key |
|---|---|
| `bootstrap/` | `bootstrap/terraform.tfstate` |
| `global/` | `global/terraform.tfstate` |
| `apps/portfolio/` | `apps/portfolio/terraform.tfstate` |

One bucket holds all of them. Each folder has its own key, so it has its own
lock file too. Applying an app can't touch `global/`, and two stacks can be
planned at the same time without waiting on each other.

## The state bucket

The bucket lives in `bootstrap/`. State files hold resource IDs, ARNs and
sometimes secrets, so the bucket gets the full treatment:

```hcl
resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}
```

What each piece is for:

- **`prevent_destroy`**: a stray `terraform destroy` in this folder fails
  instead of deleting every stack's state.
- **Versioning**: each write of a state file keeps the previous one. A bad
  apply or a corrupted state can be rolled back.
- **SSE with AES256**: encrypted at rest with S3-managed keys. `encrypt = true`
  in the backend asks for it on every write as well.
- **Public access block**: all four switches on, so no ACL or policy can ever
  make state public.
- **`BucketOwnerEnforced`**: ACLs are disabled and the bucket owner owns every
  object. Access is decided by IAM and the bucket policy only.

Two more pieces. Old versions shouldn't pile up forever, so noncurrent
versions expire after 90 days:

```hcl
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}
```

And plain HTTP is refused outright:

```hcl
data "aws_iam_policy_document" "tfstate_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.tfstate.arn,
      "${aws_s3_bucket.tfstate.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
```

The bucket name includes the account ID
(`"my-tfstate-${data.aws_caller_identity.current.account_id}"`), which keeps
it globally unique without inventing anything.

## The chicken-and-egg

The bucket is managed by Terraform, and Terraform's state lives in the bucket.
So where does the bootstrap stack keep its own state? In the bucket too, after
a migration:

1. Write `bootstrap/` **without** a backend block. Run `terraform init` and
   `terraform apply`. State is local, in `terraform.tfstate`.
2. Add the `backend "s3"` block, pointing at the bucket you just created, with
   key `bootstrap/terraform.tfstate`.
3. Move the state across:

   ```bash
   terraform init -migrate-state
   ```

   Terraform asks whether to copy the existing state to the new backend.
   Say yes.
4. Prove it worked:

   ```bash
   terraform plan
   ```

   It should say `No changes`. If it wants to create the bucket, the state
   didn't move. Stop and look before going further.
5. Delete the local `terraform.tfstate` and `terraform.tfstate.backup`. They're
   now stale copies, and the only thing they can do is confuse someone later.
   (`*.tfstate` is in `.gitignore`, so they were never committed.)

After this, `bootstrap/` behaves like every other stack. If you ever need to
change the bucket, you plan and apply it the normal way, with its state locked
in the bucket it describes.

## Rolling back a bad state

Versioning is only useful if you know how to use it. To see the history of a
stack's state:

```bash
aws s3api list-object-versions \
  --bucket my-tfstate-123456789012 \
  --prefix global/terraform.tfstate
```

Each version has a `VersionId` and `LastModified`. You can download an older
version with `aws s3api get-object --version-id ...`, check it, and push it
back with `terraform state push` if you really need to (it needs `-force`,
because the older version has a lower serial). With the 90-day
expiry, that history goes back three months.

## Checklist

1. `use_lockfile = true` and `encrypt = true` in every backend block.
2. One bucket, one key per stack, so each stack has its own lock.
3. Versioning on, with noncurrent versions expiring rather than kept forever.
4. Public access block, `BucketOwnerEnforced`, and a TLS-only bucket policy.
5. `prevent_destroy` on the bucket.
6. Bootstrap with local state, migrate, confirm `No changes`, then delete the
   local state files.
