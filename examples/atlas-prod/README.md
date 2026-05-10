# Production Atlas + AWS IAM (EKS Pod Identity)

Reference configuration for running `mongosql-cubejs-driver` against a production MongoDB Atlas cluster with **AWS IAM authentication** delegated to EKS Pod Identity.

## What it demonstrates

- `MONGODB-AWS` auth via `mongodb+srv://` URI — no static credentials in env vars or secrets.
- `__sql_schemas` populated by Atlas SQL Interface (collection mode).
- Production-tuned env vars (longer schema refresh, conservative max-rows, reasonable query timeout).
- A minimal `cube.js` that lets Cube auto-resolve the driver via the `${type}-cubejs-driver` convention.

## Prerequisites

- A MongoDB Atlas project (M10+ tier — SQL Interface requires M10 minimum).
- Atlas SQL Interface enabled on the cluster (Cluster → Services → Atlas SQL → Enable).
- An EKS cluster with [Pod Identity Agent](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) installed.
- An Atlas database user mapped to an AWS IAM Role (Atlas UI → Database Access → Add New User → AWS IAM Role).
- The Cube workload's ServiceAccount associated with the IAM Role via `eks-pod-identity-association`.

## Files

```
examples/atlas-prod/
├── README.md       (this file)
├── .env.example    (env-var contract for the workload)
└── cube.js         (Cube config — minimal, auto-resolution)
```

## How to run

This is a reference snippet, not a runnable docker-compose stack — production deployment lives in your Helm chart / Terraform / whatever orchestrator you use. The intent is to show **the env-var contract** the workload expects.

1. Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp examples/atlas-prod/.env.example examples/atlas-prod/.env
   ```

2. In your Helm/Kustomize/k8s manifest, project the env vars onto the Cube container:

   ```yaml
   # Excerpt — adapt to your chart
   env:
     - name: CUBEJS_DB_TYPE
       value: mongosql
     - name: CUBEJS_DB_URI
       valueFrom:
         secretKeyRef:
           name: cube-mongo
           key: uri
     - name: CUBEJS_DB_NAME
       value: example
     - name: CUBEJS_MONGOSQL_SCHEMA_SOURCE
       value: collection
     - name: CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC
       value: '300'
     - name: CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS
       value: '60000'
     - name: CUBEJS_MONGOSQL_MAX_ROWS
       value: '100000'
   ```

3. Mount `cube.js` (this directory) at `/cube/conf/cube.js` in the Cube container.

4. Confirm Pod Identity is wired:

   ```bash
   kubectl exec -n cube deploy/cube -- env | grep -E 'AWS_(WEB_IDENTITY|CONTAINER|ROLE)'
   ```

   You should see `AWS_CONTAINER_CREDENTIALS_FULL_URI` and `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` — the credential chain the `mongodb` Rust crate consumes for `MONGODB-AWS`.

## Expected behaviour

- Cube starts with no static MongoDB credentials in env or secrets.
- `testConnection()` succeeds within seconds (Atlas IP allowlist must include your EKS NAT or VPC private endpoint).
- `__sql_schemas` is read from the Atlas-managed sampler — no manual seeding.
- Query performance: schema lookups are O(1) once cached; first query after pod start triggers schema load (sub-second on typical clusters).

## Why MONGODB-AWS over SCRAM

- **No long-lived secrets to rotate.** Atlas accepts the IAM session token from EKS Pod Identity — no DB password to leak.
- **Per-workload identity.** Different Cube deployments can use different IAM roles for principle-of-least-privilege.
- **Vanta / SOC 2 alignment.** The credential chain is the AWS chain; your existing IAM controls cover it.

## Common issues

- **`MONGOSQL_AUTH_FAILED: BadAuth`** — Atlas hasn't been told about the IAM role yet. Atlas UI → Database Access → check that the role's ARN is registered as a database user.
- **`MONGOSQL_CONNECT_FAILED: server selection timeout`** — Atlas IP allowlist doesn't include your egress. Add your EKS NAT IPs or use Atlas Private Endpoint (preferred for prod).
- **`MONGOSQL_SCHEMA_NOT_FOUND`** — SQL Interface is enabled but hasn't sampled yet (~minutes on first enable), or it's enabled on a different database than `CUBEJS_DB_NAME`. Verify with `mongosh` against the same URI: `db.getCollection('__sql_schemas').countDocuments()`.

## Hardening recommendations for production

- **Use Atlas Private Endpoint** (PrivateLink) instead of public IP allowlisting.
- **Pin the cluster's MongoDB version** to a tested major (e.g. `7.0.x` or `8.0.x`).
- **Set `CUBEJS_MONGOSQL_SCHEMA_FAIL_OPEN=false`** (default) so misconfiguration fails the readiness probe rather than serving stale results.
- **Pre-aggregations**: monitor `MONGOSQL_RESULT_TOO_LARGE` — it's the canary for partitions too coarse.
- **Observability**: scrape `tracing`-emitted metrics via your OTel collector — see [SPEC NFR-3](../../SPEC.md#nfr-3--observability).
