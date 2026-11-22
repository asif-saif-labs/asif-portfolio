---
title: "GKE: the 30-second timeout was the load balancer, not the app"
description: "Long API calls returned 502 and websockets dropped after about 30 seconds on GKE. The cause was the load balancer's default backend timeout."
date: 2026-11-22
tags: [gcp, gke, kubernetes, argocd, load-balancing]
draft: true
---

On a QA environment of an internal AI product running on GKE, some API calls
take a while to complete. The long ones failed with a `502`, and websocket
connections dropped, at around 30 seconds. Short requests were fine.

A failure at a suspiciously round number is rarely the application. It's
usually a default timeout somewhere in the path.

## Finding the layer that cuts the connection

The request path was the usual one for GKE Ingress:

```text
client -> Google Cloud external Application Load Balancer -> NEG -> Pod
```

The pattern pointed at something in front of the pod: the failures tracked
elapsed time, not what the request was doing.

The load balancer has exactly that setting. Every backend service has a
**timeout**, and on a backend service created by GKE Ingress it defaults to
**30 seconds**. If the backend hasn't returned a complete response by then,
the load balancer returns `502` to the client.

For websockets it's worse than it sounds. On the external Application Load
Balancer, the backend service timeout is also the maximum time a websocket
connection can stay open, idle or not. So a 30-second timeout means every
websocket is cut at 30 seconds, no matter how much traffic is flowing on it.

You can confirm this in the load balancer's request logs. Timed-out requests
show up with a status detail of `backend_timeout`:

```bash
gcloud logging read \
  'resource.type="http_load_balancer" AND jsonPayload.statusDetails="backend_timeout"' \
  --project my-project --limit 20 --freshness 1h
```

And you can read the live value straight off the backend service:

```bash
gcloud compute backend-services list --project my-project \
  --format='table(name, timeoutSec)'
```

The service had no BackendConfig attached, so it was running on the default.

## The fix: a BackendConfig

On GKE Ingress you don't edit the backend service directly. GKE owns it and
will reconcile your manual change away. Instead you declare the settings in a
`BackendConfig` and attach it to the Kubernetes `Service`:

```yaml
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: my-api-backendconfig
  namespace: my-app
spec:
  timeoutSec: 3600
```

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-api
  namespace: my-app
  annotations:
    cloud.google.com/backend-config: '{"default": "my-api-backendconfig"}'
spec:
  type: ClusterIP
  selector:
    app: my-api
  ports:
    - name: http
      port: 80
      targetPort: 8000
```

`"default"` applies the config to every port of the Service. If only one port
needs it, use the per-port form instead:

```yaml
cloud.google.com/backend-config: '{"ports": {"http": "my-api-backendconfig"}}'
```

The BackendConfig must be in the same namespace as the Service. I applied it
to the API service and one other service that held long connections.

**Why 3600 seconds?** It's long enough for the slowest legitimate API call
and for websocket sessions to last a working session. Remember the trade-off:
on this load balancer the timeout is also the hard cap on websocket lifetime,
so clients should still reconnect cleanly when a connection closes. A longer
timeout doesn't replace reconnect logic.

## Shipping it through GitOps

The cluster's manifests are managed by Argo CD, so the change went in as a
pull request to the GitOps repo, not as a `kubectl apply`. After the merge,
Argo CD synced the new BackendConfig and the updated Service annotation:

```bash
argocd app sync my-app-qa
argocd app wait my-app-qa --health --sync
```

GKE's ingress controller then updated the backend service. That isn't
instant; give it a short while before testing.

## Validating

Three checks, in order:

```bash
# 1. The Service carries the annotation
kubectl -n my-app get svc my-api \
  -o jsonpath='{.metadata.annotations.cloud\.google\.com/backend-config}'

# 2. The backend service picked up the new timeout
gcloud compute backend-services list --project my-project \
  --format='table(name, timeoutSec)'

# 3. A request that used to fail now completes
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
  https://qa.example.com/api/long-running-endpoint
```

For websockets, open a connection and leave it past the old 30-second mark.

## If you're on the Gateway API

BackendConfig is for GKE Ingress. If your cluster uses the GKE Gateway
controller instead, the equivalent setting lives in a `GCPBackendPolicy`
attached to the Service. Same idea, different resource.

## Takeaways

- A timeout at a round number like 30 or 60 seconds is almost always a
  default in a proxy or load balancer, not your code.
- On GKE Ingress, the backend service timeout defaults to 30 seconds and
  also caps websocket lifetime.
- Change it with a `BackendConfig` and the
  `cloud.google.com/backend-config` annotation, never by editing the backend
  service by hand.
- Check the load balancer logs for `backend_timeout` and the backend service's
  `timeoutSec` before touching the app.
- Ship it the same way as every other manifest change, through Git and Argo CD,
  so the fix doesn't disappear on the next sync.
