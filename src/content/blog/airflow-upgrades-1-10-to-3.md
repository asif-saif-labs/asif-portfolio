---
title: "Four years of Airflow upgrades: 1.10 to 3.2"
description: "Upgrading Airflow from 1.10 through 2.x, moving it from EC2 to ECS, and standing up Airflow 3.2. What each jump taught me."
date: 2026-11-22
tags: [airflow, data-engineering, aws, ecs, upgrades]
draft: false
---

I've upgraded Airflow more times than I've upgraded anything else at work.
Over four years, many instances went from 1.10.x to 2.0, then 2.4, 2.5.3 and
2.7.x. In 2023 alone I upgraded Airflow for four client data pipelines. Along
the way we moved Airflow from EC2 to ECS, and in 2026 I stood up Airflow 3.2
servers for QA and production. These are the lessons that held across every
jump.

## Airflow upgrades are mostly about the database and the DAGs

The Airflow binaries are the easy part. Two things make upgrades hard:

1. **The metadata database.** Every release can carry schema migrations, and
   they only go forward. Once you've migrated the database, the old version
   can't use it.
2. **The DAGs.** Your DAG code imports Airflow. When Airflow moves or removes
   things, DAGs break, and they break at parse time, so a single bad import
   can make a DAG vanish from the UI.

Everything else in this post is about managing those two risks.

## 1.10 to 2.0: the big one

Airflow 2.0 was a real break. The Airflow project shipped 1.10.15 as a bridge
release: get there first, run the upgrade-check tool, fix what it reports,
then move to 2.0.

```bash
pip install apache-airflow-upgrade-check
airflow upgrade_check
```

The biggest change for DAG authors was providers. Operators and hooks for
external systems moved out of core into separate packages, so imports
changed:

```python
# 1.10
from airflow.contrib.operators.s3_to_gcs_operator import S3ToGoogleCloudStorageOperator

# 2.x
from airflow.providers.google.cloud.transfers.s3_to_gcs import S3ToGCSOperator
```

The providers are versioned and released separately, which is good long term
but means every environment now has a list of provider packages to pin and
keep compatible with the Airflow version. Use the official constraints file
for your Airflow and Python version when installing:

```bash
AIRFLOW_VERSION=2.7.3
PYTHON_VERSION=3.11
pip install "apache-airflow==${AIRFLOW_VERSION}" \
  --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-${PYTHON_VERSION}.txt"
```

Skipping the constraints file is the most common cause of a "works on my
machine" Airflow install I've seen.

## The 2.x releases: smaller jumps, same routine

Within 2.x, upgrades were calmer, but I kept the same routine for every one:

1. **Read the release notes** for every version between the current one and
   the target, not just the target. Deprecations pile up.
2. **Back up the metadata database.** A snapshot before the migration is the
   only real rollback.
3. **Test the DAGs against the new version** before touching production:
   install the new Airflow in a separate environment and make sure every DAG
   parses.
4. **Migrate the database**, then start the new scheduler and webserver.

The database command itself changed over the 2.x line. Older releases used
`airflow db upgrade`; from 2.7 the command is `airflow db migrate`, and the old
one is deprecated.

```bash
airflow db check
airflow db migrate
```

A cheap DAG compatibility check is to load every DAG and fail on any import
error:

```python
# test_dag_integrity.py
from airflow.models import DagBag

def test_no_import_errors():
    dag_bag = DagBag(dag_folder="dags/", include_examples=False)
    assert not dag_bag.import_errors, dag_bag.import_errors
```

Run that in CI against the target version and most upgrade surprises show up
before deploy day.

## EC2 to ECS

Early on, Airflow ran on EC2 instances. Upgrading a long-lived server in place
means every instance can drift a little differently, and rolling back means
undoing changes on that machine.

Moving Airflow to ECS changed upgrades more than any Airflow release did.
Airflow became a container image with pinned versions. The scheduler,
webserver and workers became ECS services built from the same image. An
upgrade became a new image tag, and a rollback (before the database
migration) became the old tag.

## Airflow 3.2: build new, run side by side

For Airflow 3 I didn't upgrade in place. I stood up new Airflow 3.2 servers
for QA and production, defined in Terraform (an ECS cluster and the IAM roles
around it) and deployed through GitHub Actions. I also wrote a deployment
runbook so the next Airflow server follows the same steps instead of starting
from scratch.

Running the new version beside the old one is the safest pattern for a major
version: each has its own metadata database, DAGs can move over one pipeline at a
time, and the old server can stay available until the last DAG has run
cleanly on the new one.

## What changed in Airflow 3

At a high level, the changes I'd flag for anyone moving from 2.x:

- **Tasks no longer talk to the metadata database directly.** They go through
  a Task Execution API served by the API server. Code that opened a database
  session inside a task needs to change.
- **The webserver is replaced by the API server** (`airflow api-server`), and
  the DAG processor runs as its own component.
- **DAG authoring has a new home:** the Task SDK under `airflow.sdk`.
- **Removed features:** SubDAGs are gone (use task groups), and
  `execution_date` and `schedule_interval` are replaced by `logical_date` and
  `schedule`.
- **The REST API moved to v2**, so anything calling `/api/v1` needs updating.
- **A new UI**, and DAG versioning.

```python
# Airflow 3 style
from airflow.sdk import dag, task

@dag(schedule="@daily", catchup=False)
def my_pipeline():
    @task
    def extract():
        ...
    extract()

my_pipeline()
```

Ruff has Airflow-specific lint rules (the `AIR3` series) that flag many of the
removed and moved imports. Running them over a DAG repo is a quick way to size
the work.

## Lessons

- The metadata database decides your rollback. Snapshot it before every
  migration.
- Pin everything: Airflow with its constraints file, and every provider.
- Test that every DAG parses on the target version, in CI, before deploy day.
- Containers made Airflow upgrades routine. If Airflow still lives on a
  hand-built server, move it first and upgrade second.
- For a major version, build new and run side by side. Move DAGs over, then
  retire the old server.
- Write the runbook while you do it. The next server is always sooner than
  you think.
