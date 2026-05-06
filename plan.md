# APIx Offsite Hackathon — Paid Atlas Clusters in MCP Server

Living planning + log doc. Append rather than rewrite as we learn.

## TL;DR of the brief

- **Title:** "MCP Hackathon: Paid Atlas Clusters" (Google Doc by Agustin Bettati).
- **Time box:** 2 hours.
- **Problem:** today the MCP server can only create _free-tier_ clusters. Paid-cluster support is on the formal Q2 roadmap (Jira `MCP-464`).
- **Why a hackathon:** before committing to a design, leadership wants **multiple working implementations of two competing tool-shape approaches** so the evals harness can drive the decision with evidence (success rate, token usage, behaviour across model tiers) instead of opinion.
- **Required deliverable:** a fork of `mongodb-js/mongodb-mcp-server` with new tools on a branch.
- **Strongly encouraged:** `pnpm run inspect` smoke test against cloud-dev + an E2E run through an MCP client (Claude Code/Desktop, Cursor, VS Code) driven by a natural-language prompt.

## The two approaches we're choosing between

|                    | Approach A — API-mirroring                              | Approach B — Curated, task-scoped                                                                                                     |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Tool count         | Few                                                     | More                                                                                                                                  |
| Schema shape       | Tracks Atlas Admin API closely (create / update / read) | Opinionated, narrow per task (e.g. `atlas-create-replica-set-cluster`, `atlas-pause-cluster`)                                         |
| Composition burden | LLM assembles primitives to match intent                | Each tool already encodes one user intent                                                                                             |
| Inspirations       | Raw Admin API                                           | Atlas UI flows + [`terraform-mongodbatlas-cluster`](https://github.com/terraform-mongodbatlas-modules/terraform-mongodbatlas-cluster) |

Hackathon target: **≥2 implementations of each approach** across all participants. We pick one (A or B) and register it in the submissions sheet.

## Use cases the tools must cover

Drawn 1:1 from `case_8_mcp_tool_strategy` in the evals repo.

### Cluster creation

1. **Dev cluster** — single-region AWS M10, compute + disk autoscaling, no backup. (case_8 ex1 `all_tools`, ex2 `presets_only`.)
2. **Budget production** — single-region `US_EAST_1`, M30+, autoscaling, backup enabled, cluster paused after creation. (case_8 ex3 `full_crud_only`.)
3. **Multi-region** — 3+ AWS regions, electable nodes in each, ≥5 total electable nodes, M30+, autoscaling, backup, cluster paused after creation. (case_8 ex4 `create_only`.)

### Cluster management

- **Pause** — wait for `IDLE` then issue pause. (Post-step in ex3 + ex4.)
- From doc comments (Alexander Johansson): scale up (instance size), scale up (instance size + autoscaling configs), scale down (instance size).

## What we already know from local context (HACKATHON.md + code)

- Reference implementation lives at [`src/tools/atlas/create/createFreeCluster.ts`](src/tools/atlas/create/createFreeCluster.ts) — one Tool class extending `AtlasToolBase`, four required members (`toolName`, `category`, `operationType`, `description` + `argsShape` + `execute` + optional `resolveTelemetryMetadata`).
- Atlas API client: `this.apiClient.createCluster({ params: { path: { groupId } }, body })` in [`src/common/atlas/apiClient.ts:313`](src/common/atlas/apiClient.ts).
- API version pin: `Accept: application/vnd.atlas.2025-03-12+json` (see `ATLAS_API_VERSION`), which routes to the `2024-10-23` `createGroupCluster` handler — so request bodies must match the **Independent Shard Scaling** schema (one `replicationSpecs[]` per shard, no `numShards`).
- Body schema is `ClusterDescription20240805` (in `openapi.d.ts`). Shaped using the canonical examples in `hackathon-examples/`:
  - [`replica-set-request.json`](hackathon-examples/replica-set-request.json) — REPLICASET, AWS US_EAST_1, 3×M10, autoscale M10→M40.
  - [`sharded-request.json`](hackathon-examples/sharded-request.json) — SHARDED, 2 shards × 3×M30, autoscale M30→M60.
- New Atlas tools must be re-exported from [`src/tools/atlas/tools.ts`](src/tools/atlas/tools.ts). `AllTools` aggregator picks them up automatically.
- Validation helpers in [`src/tools/args.ts`](src/tools/args.ts): `AtlasArgs.projectId / clusterName / region / projectName / username / password / ipAddress / cidrBlock`.
- Public-API check: any new tool class triggers an api-extractor diff. Run `pnpm run update:api` and commit `api-extractor/reports/`.
- Auth/setup: env vars `MDB_MCP_API_CLIENT_ID`, `MDB_MCP_API_CLIENT_SECRET`, `MDB_MCP_API_BASE_URL=https://cloud-dev.mongodb.com`. Inspector via `pnpm run inspect`. Integration tests default to cloud-dev when those creds are set (`describeWithAtlas` skips otherwise).
- Currently exported Atlas tools (post-free-cluster baseline): list/create projects, list/inspect clusters, create-free-cluster, access list create/inspect, list/create DB users, connect cluster, list orgs, list alerts, perf advisor, streams (discover/build/manage/teardown).

## Decisions (locked in 2026-05-06)

| #   | Question          | Answer                                                                                      |
| --- | ----------------- | ------------------------------------------------------------------------------------------- |
| 1   | Approach          | **A — API-mirroring** (few general tools, LLM composes)                                     |
| 2   | Group             | Solo                                                                                        |
| 3   | Submissions sheet | Already registered                                                                          |
| 4   | Cloud-dev creds   | Service-account client ID + secret in repo-local `.env` (verify load mechanism — see Risks) |
| 5   | Branch            | Stay on `apix-offsite-hackathon-matt` (already a forked branch)                             |
| 6   | case_8 eval spike | Yes — dispatched to parallel agent                                                          |
| 7   | Scope             | **Creation only** first (dev / budget-prod / multi-region). Pause + scale only if time      |

## Approach-A working hypothesis

Approach A says: don't pre-package user intents into bespoke tools. Instead expose primitives that mirror the Atlas Admin API and trust the LLM to assemble them. Working theory of the minimum surface (will validate against case_8 spike before locking):

- `atlas-create-cluster` — generic create that accepts the full `ClusterDescription20240805` shape (or a thin Zod surface that maps to it): `clusterType`, `replicationSpecs[]` (incl. autoScaling per regionConfigs entry), `backupEnabled`, `terminationProtectionEnabled`, etc. Replaces the hardcoded `atlas-create-free-cluster` shape with a general one (we keep the free-cluster tool intact for non-paid use).
- _(Maybe)_ `atlas-update-cluster` — needed if the eval requires post-create mutation (pause, scale). Mirrors `PATCH /groups/{gid}/clusters/{name}`.
- _(Maybe)_ `atlas-wait-for-cluster-state` — needed if the eval requires waiting for `IDLE` before pausing. Could be deferred since pause is out of MVP scope.

Open design questions (resolve after case_8 spike returns):

- How thin is the Zod surface? Pure pass-through `z.object({}).loose()` is most "API-mirroring" but loses LLM affordances. A typed but permissive surface (enum for `clusterType`, structured `replicationSpecs[]`) is probably the sweet spot.
- Do we expose region/instance enums or strings? Real API uses strings; enums help the LLM but bias us toward Approach B.

## Risks / things to watch

- **2-hour clock.** A clean tool + smoke test is more valuable than half-done full coverage. Bias toward shipping one approach end-to-end.
- **`.env` is NOT auto-loaded.** Confirmed: `package.json#scripts.inspect` runs `mcp-inspector -- dist/esm/index.js` with no dotenv preload, and `process.env.MDB_MCP_API_*` is read directly (`src/setup/setupMcpServer.ts`). Repo does not use `dotenv` / `env-cmd` / `dotenvx`. **Workaround for our shell:** `set -a; source .env; set +a; pnpm run inspect` — or export the two vars manually. Same applies for the integration test runner. (Long-term, repo could add a `.env`-loading inspect wrapper, but out of scope for the 2-hour box.)
- **Cold-start npx install (~90–120s)** breaks Claude Desktop / Code default MCP timeouts — see Agustin's comment on the doc and HACKATHON.md §5.3. Build locally and point clients at `dist/esm/index.js` to avoid this.
- **Approach A** has to handle "pause after IDLE" — that's a polling/wait flow. Either expose a `wait-for-state` primitive (A's spirit) or fold the wait into the update tool. We're deferring pause anyway (see decision #7) so this only re-enters scope if time permits.
- **api-extractor diff** will fail `pnpm run check` until `pnpm run update:api` is run; budget a minute for that at the end.
- **Read-only mode** would block any `create`/`update` tool — confirm `config.readOnly` is false in our local env.

## Parallel work in flight

- **case_8 eval spike** dispatched 2026-05-06 to a background research agent. Goal: pull the verbatim eval prompts, confirm the variant splits (`all_tools`, `full_crud_only`, `create_only`), enumerate success-criteria assertions, and call out the _minimum_ API-mirroring tool surface those evals force on us. Will fold the findings into the Approach-A working hypothesis before any code lands.

## Decisions log (append as we go)

- 2026-05-06 — kicked off; ingested HACKATHON.md, brief (via Glean — Google Doc itself is auth-gated for unauthenticated WebFetch), createFreeCluster reference, hackathon-examples payloads. Awaiting answers to open questions before committing to A/B.
- 2026-05-06 — locked decisions: Approach **A**, solo, scope = creation-only first, branch `apix-offsite-hackathon-matt`, case_8 spike running in parallel. Cred file is `.env` at repo root — repo does not auto-load it.
- 2026-05-06 — design brainstorm complete. Locked: one new tool `atlas-create-cluster` (typed-permissive Zod schema mirroring the Atlas POST body structure), coexisting with `atlas-create-free-cluster`, no defaults on body fields, `ensureCurrentIpInAccessList` kept for connectivity UX, full API response returned so LLM can reason on post-create state. Schema trimmed to creation essentials (`readOnlySpecs`, `analyticsSpecs`, `tags`, `pitEnabled`, `mongoDBMajorVersion` all deferred). `atlas-update-cluster` deferred (rego doesn't gate on `paused`).
- 2026-05-06 — spec written to [`docs/superpowers/specs/2026-05-06-paid-atlas-clusters-approach-a-design.md`](docs/superpowers/specs/2026-05-06-paid-atlas-clusters-approach-a-design.md). Self-review passed. Awaiting user review before invoking `writing-plans`.
- 2026-05-06 — user approved spec; skipped formal `writing-plans` for this single-file change. `CreateClusterTool` implemented at [`src/tools/atlas/create/createCluster.ts`](src/tools/atlas/create/createCluster.ts), re-exported from [`src/tools/atlas/tools.ts`](src/tools/atlas/tools.ts). `pnpm run check` clean (build + types + lint + format + knip + api-extractor) after `pnpm run reformat` + `pnpm run update:api`. Awaiting smoke test against cloud-dev.

## Learnings log (append as we go)

- WebFetch on the Google Doc returns 401; Glean's `read_document` works because it has authenticated access.
- HACKATHON.md is current and correct; the live branch matches `apix-offsite-hackathon` (see brief's link).
- Repo does not load `.env` — confirmed by absence of dotenv in `package.json` and direct `process.env.*` reads in `src/setup/setupMcpServer.ts`. `pnpm run inspect` is `mcp-inspector -- dist/esm/index.js`, which inherits parent shell env only.
- `inspect` script is `pnpm run build && mcp-inspector -- dist/esm/index.js` — every inspect run does a full build, so iteration cycle is "edit → run → ~build time → click in inspector".
- **case_8 eval key findings:** (1) Pause is not gated by rego — the eval prompts say "pause the cluster" but no `paused == true` assertion exists in the OPA policies. (2) The `all_tools` / `presets_only` / `full_crud_only` / `create_only` variant axis applies only to ex1/ex2 (which use `bodegus/mongodb_atlas_mcp`). ex3 and ex4 just consume whatever tools this MCP server ships — no variant switch-over. (3) ex3/ex4 currently point at `AgustinBettati/mongodb-mcp-server#devops-integrations-ai-hackathon`, not our branch — the eval must be re-pointed for our work to be assessed.
- **ex4 hard floor:** ≥3 AWS regions with electable nodes in each, ≥5 total electable nodes. The rego asserts distinct `region_names`, not just distinct replicationSpecs entries — multi-region means multi-`regionConfigs[]`, not multi-replicationSpecs-with-same-region.
- **Approach A schema rationale:** no closed enums on `instanceSize` / `regionName` / `providerName` — Atlas adds these continuously. Structure typed, leaf values stay open strings. LLM reads `.describe()` hints, not a curated taxonomy. Dropping `readOnlySpecs`/`analyticsSpecs` fields entirely is strictly _better_ for ex1 (deny rule on non-zero analytics/RO counts): if you can't set them, you can't fail them.

---

## Implementation considerations worth highlighting

> Quick-reference for anyone extending this work or building a competing submission.

### 1. `autoScaling` belongs on each `regionConfigs[]` entry, NOT top-level

The single most common Atlas API misuse in LLM-generated bodies. The schema has no top-level `autoScaling`; placing it there silently drops it. Each shard/region must carry its own `autoScaling` block:

```json
"regionConfigs": [{
  "providerName": "AWS",
  "regionName": "US_EAST_1",
  "priority": 7,
  "electableSpecs": { "instanceSize": "M10", "nodeCount": 3 },
  "autoScaling": {
    "compute": { "enabled": true, "scaleDownEnabled": true, "minInstanceSize": "M10", "maxInstanceSize": "M40" },
    "diskGB": { "enabled": true }
  }
}]
```

### 2. Independent Shard Scaling format — no `numShards`

The API version in use (`2024-10-23`, reached via the `2025-03-12` pin in `ATLAS_API_VERSION`) requires one `replicationSpecs[]` entry _per shard_, not a single entry with a `numShards` field. A symmetric 2-shard cluster has two identical entries. Old-style `numShards` bodies will be rejected or silently mishandled by this API version.

### 3. `pnpm run inspect` won't see your `.env`

The repo has no dotenv loading. Credentials stored in `.env` at the project root must be exported manually before running the inspector or tests:

```bash
set -a; source .env; set +a; pnpm run inspect
```

`MDB_MCP_API_BASE_URL=https://cloud-dev.mongodb.com` must also be set — the default is prod (`cloud.mongodb.com`).

### 4. Pause is not a rego assertion — it's a prompt-only ask

The case_8 eval prompts for ex3 and ex4 say "pause the cluster after creation" but the OPA rego policies contain no `paused == true` deny rule. Passing all rego suites does not require implementing pause. Add `atlas-update-cluster` if you want to honour the natural-language ask; skip it if you're time-constrained.

### 5. `pnpm run update:api` is required after adding a new tool class

Any new tool re-exported from `src/tools/atlas/tools.ts` changes the package's public API surface and triggers an api-extractor diff. `pnpm run check` (and CI) will fail until you regenerate the reports:

```bash
pnpm run update:api
git add api-extractor/reports/
```

### 6. ex3/ex4 evals use this repo's branch directly — no tool-variant switch

Only ex1/ex2 use the `MONGODB_ATLAS_TOOL_SET` environment variable. ex3 and ex4 consume whichever toolset ships on the `mongodb-mcp-server` branch their `.mcp.json` points at. There is no `full_crud_only` or `create_only` mode to configure — just build the right tools and make sure the branch name matches what the eval points at.

### 7. M10 vs M30 — tier requirements by eval case

| Eval case         | Min tier            | Backup               | Autoscaling             | Regions                         |
| ----------------- | ------------------- | -------------------- | ----------------------- | ------------------------------- |
| ex1 (dev)         | M10 (M20 ok, warns) | off (on = warn only) | compute + disk required | 1 AWS                           |
| ex3 (budget prod) | M30+                | **required**         | compute + disk required | 1 AWS US_EAST_1                 |
| ex4 (HA prod)     | M30+                | **required**         | compute + disk required | **≥3 AWS**, ≥5 total electables |

## Links

- Brief (Google Doc, auth-gated): https://docs.google.com/document/d/1SRj6vUnB_17zskFneJp4QQ2oGLCilaEdqLpk_q23JMY/edit?tab=t.0
- Repo: https://github.com/mongodb-js/mongodb-mcp-server
- Hackathon branch + dev guide: https://github.com/mongodb-js/mongodb-mcp-server/tree/apix-offsite-hackathon
- HACKATHON.md (in this repo): [HACKATHON.md](HACKATHON.md)
- Evals harness: https://github.com/mongodb-labs/mdb-atlas-devops-llm-evals
- Eval cases (case_8 — exact prompts we're targeting): https://github.com/mongodb-labs/mdb-atlas-devops-llm-evals/tree/main/cases/case_8_mcp_tool_strategy
- Submissions sheet: https://docs.google.com/spreadsheets/d/1Deui_uUKjykVMwQW4z2_KLo7w7TBjEG61LzhgwknyBQ/edit?gid=0#gid=0
- Approach-B inspiration: https://github.com/terraform-mongodbatlas-modules/terraform-mongodbatlas-cluster
- Q2 roadmap ticket: https://jira.mongodb.org/browse/MCP-464
