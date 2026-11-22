---
title: "S3 + CloudFront static hosting, done properly"
description: "A private bucket behind Origin Access Control, security headers, clean URLs from a CloudFront Function and real 404s. The Terraform module behind this site."
date: 2026-11-22
tags: [aws, cloudfront, s3, terraform]
draft: false
---

This site is a folder of static HTML. The quickest way to put that on AWS is
an S3 bucket with static website hosting turned on and a public-read policy.
It works, and it's the setup I wanted to avoid: a public bucket, no HTTPS on
the bucket endpoint, and no control over headers. So I wrote a small Terraform
module, `static-site`, that every static frontend I build will reuse.

## The shape

```text
private S3 bucket  ──OAC──►  CloudFront  ──►  Route 53 alias (A + AAAA)
                              │
                              ├─ CloudFront Function (viewer-request)
                              ├─ managed cache policy
                              └─ response headers policy
```

Nobody talks to S3 directly. CloudFront is the only reader.

## A private bucket and Origin Access Control

The bucket blocks all public access, disables ACLs with
`BucketOwnerEnforced` and encrypts at rest. CloudFront reads it through an
Origin Access Control, which signs every request to S3 with SigV4:

```hcl
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
```

The bucket policy then allows `s3:GetObject` to the CloudFront service, but
only on behalf of this one distribution:

```hcl
statement {
  sid       = "CloudFrontRead"
  actions   = ["s3:GetObject"]
  resources = ["${aws_s3_bucket.site.arn}/*"]

  principals {
    type        = "Service"
    identifiers = ["cloudfront.amazonaws.com"]
  }

  condition {
    test     = "StringEquals"
    variable = "AWS:SourceArn"
    values   = [aws_cloudfront_distribution.site.arn]
  }
}
```

The `AWS:SourceArn` condition matters. Without it, any CloudFront distribution
in any account could point at your bucket and read it. A second statement
denies all `s3:*` when `aws:SecureTransport` is false.

Note what's missing: `s3:ListBucket`. CloudFront can fetch objects it knows
the name of, but it can't list the bucket. That has a side effect I come back
to below.

## Caching and compression

The default behaviour uses the AWS managed `CachingOptimized` policy, looked
up by name rather than hard-coding its ID:

```hcl
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}
```

It doesn't forward cookies, query strings or headers to the origin, which is
right for a static site. `compress = true` lets CloudFront serve gzip and
Brotli. The deploy sets `Cache-Control` on each object, and CloudFront and
browsers respect it within the policy's TTL limits, instead of one global TTL
for everything.

## Security headers

A response headers policy adds the headers on every response, with
`override = true` so whatever is on the object doesn't win:

```hcl
security_headers_config {
  strict_transport_security {
    access_control_max_age_sec = 63072000
    include_subdomains         = true
    preload                    = false
    override                   = true
  }
  content_type_options {
    override = true
  }
  frame_options {
    frame_option = "DENY"
    override     = true
  }
  referrer_policy {
    referrer_policy = "strict-origin-when-cross-origin"
    override        = true
  }
  content_security_policy {
    content_security_policy = var.content_security_policy
    override                = true
  }
}
```

That's HSTS for two years, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, a Referrer-Policy and a CSP. The default CSP is
`default-src 'self'` with a few additions, and `frame-ancestors 'none'`.
`Permissions-Policy` isn't one of the built-in security headers, so it goes in
as a custom header that turns off camera, microphone and geolocation.

## Clean URLs with a CloudFront Function

Here's the catch with a private bucket. S3's static website hosting is what
serves `index.html` for `/about/`. OAC works with the bucket's REST endpoint,
which has no index documents. `default_root_object` only covers `/`. So
`/blog/` and `/about` would both fail.

A small CloudFront Function on viewer-request (runtime `cloudfront-js-2.0`)
rewrites the path before CloudFront looks in the cache:

```js
var uri = request.uri;
if (uri.endsWith("/")) {
  request.uri = uri + "index.html";
} else if (uri.split("/").pop().indexOf(".") === -1) {
  request.uri = uri + "/index.html";
}
return request;
```

`/blog/` becomes `/blog/index.html`, `/about` becomes `/about/index.html`, and
anything with a file extension, like `/rss.xml`, passes through untouched.

The same function does one more job. Every distribution also answers on its
`*.cloudfront.net` address, and I want search engines to index one address. So
any request on a host other than the custom domain gets a 301:

```js
if (CANONICAL_HOST && host !== CANONICAL_HOST) {
  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: {
      location: { value: "https://" + CANONICAL_HOST + request.uri + querystring(request.querystring) },
      "cache-control": { value: "max-age=3600" },
    },
  };
}
```

The file is a Terraform template, so `CANONICAL_HOST` is filled in by
`templatefile()`. It's empty until the site has a custom domain, which turns
the redirect off. The `querystring()` helper rebuilds the query string from
the event object, including repeated keys, so the redirect keeps it.

## Real 404s

Because CloudFront can't list the bucket, S3 answers a missing object with
**403 Access Denied**, not 404. Left alone, a mistyped URL shows an XML error
from S3. Two custom error responses fix that:

```hcl
custom_error_response {
  error_code            = 403
  response_code         = 404
  response_page_path    = "/404.html"
  error_caching_min_ttl = 60
}

custom_error_response {
  error_code            = 404
  response_code         = 404
  response_page_path    = "/404.html"
  error_caching_min_ttl = 60
}
```

Both return the site's own 404 page with an actual 404 status, so crawlers
don't index missing pages as real ones. The short error TTL means a page that
appears in the next deploy isn't stuck as a 404 for long.

## The rest of the distribution

```hcl
price_class     = "PriceClass_200"
http_version    = "http2and3"
is_ipv6_enabled = true
```

- **Price class**: I'm in Bengaluru and expect a lot of readers from India.
  `PriceClass_200` includes India edge locations; `PriceClass_100` does not.
- **HTTP/2 and HTTP/3** are both on, and IPv6, with A and AAAA alias records.
- **Viewer protocol**: `redirect-to-https`, only `GET` and `HEAD` allowed.
- **TLS**: `sni-only` with a minimum of `TLSv1.2_2021`.
- **Certificate**: CloudFront only accepts ACM certificates from `us-east-1`,
  whatever region the rest of your stack is in. I keep a second provider alias
  for that one region.

## Checklist

1. Bucket private: public access block on, ACLs disabled, no website hosting.
2. OAC with SigV4, and a bucket policy with `AWS:SourceArn` set to your
   distribution.
3. A viewer-request function for `index.html` on directory URLs, plus a 301 to
   the canonical host.
4. Map both 403 and 404 to `/404.html` with a 404 status.
5. Security headers from a response headers policy, with `override = true`.
6. Pick the price class for where your readers are.
7. Certificate in `us-east-1`.
