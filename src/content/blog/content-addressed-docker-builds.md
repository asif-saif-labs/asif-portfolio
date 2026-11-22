---
title: "Faster CI with content-addressed Docker dependency layers"
description: "Build dependencies into their own image, tag it with a hash of the lockfiles, and only rebuild it when that hash changes."
date: 2026-11-22
tags: [docker, ci-cd, github-actions, gke]
draft: false
---

At work, CI on several frontend and backend repos repeated the same step on
every push: installing dependencies. `npm ci` or `pip install` ran even when
the only change was one line of application code, and the dependencies
hadn't changed at all.

So I made the dependencies their own image, named after their content.

## The idea

Dependencies change rarely. Application code changes on every commit. If the
dependency layer is identified by a hash of the files that define it, then:

- the same lockfile always gives the same tag,
- a tag that already exists in the registry never needs building again,
- a lockfile change gives a new tag and one rebuild.

That's content addressing: the name is derived from the content, so "is this
already built?" becomes "does this tag exist?".

## Two Dockerfiles

The dependency image installs only dependencies:

```dockerfile
# Dockerfile.deps
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
```

The app image starts from it, with the tag passed in as a build argument:

```dockerfile
# Dockerfile
ARG DEPS_IMAGE
FROM ${DEPS_IMAGE}
WORKDIR /app
COPY . .
RUN npm run build
```

For a Python backend it's the same shape: `requirements.txt` (or
`poetry.lock`) and a `pip install` in the deps image, application code in
the app image.

## The workflow

GitHub Actions has `hashFiles()`, which returns a SHA-256 hash of the matched
files. That's the tag. Before building, the job checks whether the registry
already has it:

```yaml
env:
  IMAGE: europe-docker.pkg.dev/my-project/my-repo/my-app

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # ... authenticate to the registry here ...

      - name: Compute deps tag
        id: deps
        run: |
          hash="${{ hashFiles('package-lock.json', 'Dockerfile.deps') }}"
          if [ -z "$hash" ]; then
            echo "No files matched for the deps hash" >&2
            exit 1
          fi
          echo "tag=deps-${hash:0:16}" >> "$GITHUB_OUTPUT"

      - name: Check whether deps image exists
        id: check
        run: |
          if docker manifest inspect "$IMAGE:${{ steps.deps.outputs.tag }}" > /dev/null 2>&1; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Build and push deps image
        if: steps.check.outputs.exists == 'false'
        run: |
          docker build -f Dockerfile.deps -t "$IMAGE:${{ steps.deps.outputs.tag }}" .
          docker push "$IMAGE:${{ steps.deps.outputs.tag }}"

      - name: Build and push app image
        run: |
          docker build \
            --build-arg DEPS_IMAGE="$IMAGE:${{ steps.deps.outputs.tag }}" \
            -t "$IMAGE:${{ github.sha }}" .
          docker push "$IMAGE:${{ github.sha }}"
```

On most pushes the check finds the tag, the deps build is skipped, and the
app build pulls one existing image and copies source on top of it.

`docker manifest inspect` asks the registry for the manifest without pulling
any layers, so the check is cheap. `docker buildx imagetools inspect` does the
same job if you prefer buildx.

## What goes into the hash

The hash has to change whenever the dependency image would come out
different. I include:

- **the lockfile(s)**: `package-lock.json`, `yarn.lock`, `poetry.lock`,
  `requirements*.txt`,
- **the deps Dockerfile itself**, so changing the base image or the install
  command produces a new tag.

Leave out anything that isn't an input. If you hash the whole repository, the
tag changes on every commit and you're back where you started.

Guard against an empty hash. `hashFiles()` returns an empty string when no
files match, for example after a lockfile is renamed. Without the check
above, every build would quietly share one tag called `deps-`.

## Building only what changed

The same principle applies one level up. In a repo with several images, or in
workflows that deploy several services to GKE, each image can be skipped when
its inputs haven't changed. A paths filter on the workflow is the coarse
version:

```yaml
on:
  push:
    paths:
      - "services/api/**"
      - ".github/workflows/api.yml"
```

The hash-and-check step is the finer version, because it decides inside the
job.

## Trade-offs

- **Base image updates don't change the hash.** If your deps image is built
  `FROM node:20-slim`, it keeps the base it was built with until the lockfile
  or the Dockerfile changes. Pin the base by digest in `Dockerfile.deps` and
  update it deliberately, or rebuild on a schedule.
- **Old tags accumulate.** Every lockfile change leaves one more image
  behind. Set a registry cleanup policy for `deps-*` tags.
- **Two images to reason about.** The app Dockerfile must not reinstall
  dependencies, or you've paid for both.
- **Why not just the layer cache?** BuildKit caching (`--cache-from`, or the
  GitHub Actions cache backend) works and is worth having. The difference is
  that a tagged image in the registry is explicit: any workflow, branch or
  runner can use it, and you can see exactly which dependency set an app image
  was built on.

## Checklist

1. Move dependency installation into its own Dockerfile.
2. Tag the image with a hash of the lockfiles and that Dockerfile.
3. Check the registry for the tag before building, and fail on an empty hash.
4. Build the app image `FROM` the deps image via a build argument.
5. Pin the base image and plan for updating it.
6. Add a cleanup policy for old dependency tags.
