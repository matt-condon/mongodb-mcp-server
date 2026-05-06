# Paid Atlas Clusters — Approach A (API-mirroring) Design

**Date:** 2026-05-06
**Author:** Matt Condon (`apix-offsite-hackathon-matt`)
**Context:** APIx offsite 2-hour hackathon. The MongoDB MCP server today only creates free-tier clusters. The brief ([Google Doc — "MCP Hackathon: Paid Atlas Clusters"](https://docs.google.com/document/d/1SRj6vUnB_17zskFneJp4QQ2oGLCilaEdqLpk_q23JMY/edit?tab=t.0); see also [`HACKATHON.md`](../../../HACKATHON.md) and [`plan.md`](../../../plan.md)) asks for ≥2 working implementations of each of two competing tool-shape philosophies — "Approach A — API-mirroring" and "Approach B — Curated, task-scoped" — so the [`mdb-atlas-devops-llm-evals`](https://github.com/mongodb-labs/mdb-atlas-devops-llm-evals) harness can drive the decision with evidence. This spec is one Approach A entry.

## Goal

Add the smallest API-mirroring tool surface that lets an LLM clear all three rego suites in [`case_8_mcp_tool_strategy`](https://github.com/mongodb-labs/mdb-atlas-devops-llm-evals/tree/main/cases/case_8_mcp_tool_strategy) (ex1 dev cluster, ex3 budget production, ex4 HA production) without curating intent into the tool surface. The LLM composes the body; we mirror the API.

## Non-goals

- Cluster pause / scale / delete (case_8 rego doesn't gate on `paused`; deferred unless the 2-hour clock has slack).
- A separate `atlas-update-cluster` tool (same rationale).
- Replacing or removing `atlas-create-free-cluster` (out of scope; coexistence preserves baselines).
- Approach B variants (different submission).
- Wiring the eval harness to point at this branch (`AgustinBettati/mongodb-mcp-server#devops-integrations-ai-hackathon` is what ex3/ex4 currently consume — flagged in [`plan.md`](../../../plan.md), not solved here).

## Architecture

One new tool class added to the existing tool registry. No changes to `ToolBase`, `AtlasToolBase`, `ApiClient`, or any shared infrastructure.

```
src/tools/atlas/
├── atlasTool.ts                       # AtlasToolBase — unchanged
├── tools.ts                           # registry — add ONE re-export
└── create/
    ├── createFreeCluster.ts           # unchanged (kept for coexistence)
    └── createCluster.ts                # NEW — this spec
```

The new tool extends `AtlasToolBase`. It uses the existing `this.apiClient.createCluster(...)` wrapper around `POST /api/atlas/v2/groups/{groupId}/clusters` (Atlas Admin API, version-pinned to `2025-03-12` which routes to the `2024-10-23` `createGroupCluster` handler — Independent Shard Scaling format). No new API client method needed.

## Tool surface

### `atlas-create-cluster`

| Field                  | Value                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static toolName`      | `"atlas-create-cluster"`                                                                                                                                                     |
| `static category`      | `"atlas"` (inherited via `AtlasToolBase`)                                                                                                                                    |
| `static operationType` | `"create"`                                                                                                                                                                   |
| `description`          | Action-oriented; names the API operation it mirrors plus the most-missed gotchas: per-region `autoScaling`, Independent Shard Scaling format, free-tier alternative pointer. |

**Description text:**

> Create a MongoDB Atlas cluster. Mirrors `POST /api/atlas/v2/groups/{groupId}/clusters` (Atlas Admin API, Independent Shard Scaling format). Use for paid (M10+) replica set, sharded, or geosharded clusters; for free-tier (M0/TENANT) clusters `atlas-create-free-cluster` is a simpler alternative. `autoScaling` lives on each `regionConfigs[]` entry, not at the top level. SHARDED clusters use one `replicationSpecs[]` entry per shard (no `numShards` field).

### `argsShape` (typed-permissive, structure-faithful)

```ts
public argsShape = {
    projectId: AtlasArgs.projectId().describe(
        "Atlas project ID. Mirrors {groupId} in POST /api/atlas/v2/groups/{groupId}/clusters."
    ),
    name: AtlasArgs.clusterName().describe("Cluster name."),
    clusterType: z.enum(["REPLICASET", "SHARDED", "GEOSHARDED"])
        .describe("Cluster topology type."),

    replicationSpecs: z.array(
        z.object({
            zoneName: z.string().optional().describe(
                "Zone name. Required for GEOSHARDED. Conventional value: 'Zone 1'."
            ),
            regionConfigs: z.array(
                z.object({
                    providerName: z.string().describe(
                        "AWS | AZURE | GCP | TENANT (TENANT = free/flex)."
                    ),
                    backingProviderName: z.string().optional().describe(
                        "Required when providerName is TENANT (the underlying cloud)."
                    ),
                    regionName: z.string().describe("Cloud region, e.g. 'US_EAST_1'."),
                    priority: z.number().int().min(0).max(7).optional().describe(
                        "Region priority. 7 = primary; required for dedicated tiers (M10+)."
                    ),
                    electableSpecs: z.object({
                        instanceSize: z.string().describe("e.g. 'M10', 'M30'."),
                        nodeCount: z.number().int().min(0).optional().describe(
                            "Typically 3 for replica sets. Required for dedicated; omit for TENANT."
                        ),
                    }).optional(),
                    autoScaling: z.object({
                        compute: z.object({
                            enabled: z.boolean(),
                            scaleDownEnabled: z.boolean().optional(),
                            minInstanceSize: z.string().optional().describe(
                                "Required when scaleDownEnabled is true."
                            ),
                            maxInstanceSize: z.string().optional().describe(
                                "Required when compute.enabled is true."
                            ),
                        }).optional(),
                        diskGB: z.object({ enabled: z.boolean() }).optional(),
                    }).optional().describe(
                        "Per-region autoscaling. Lives on EACH regionConfigs entry, not top-level."
                    ),
                })
            ).describe("Per-region node configs within this replication spec / shard."),
        })
    ).describe(
        "One entry for replica sets; one per shard for SHARDED " +
        "(Independent Shard Scaling — no numShards)."
    ),

    backupEnabled:                z.boolean().optional(),
    terminationProtectionEnabled: z.boolean().optional(),
};
```

### Schema design rules (the part that defines the comparison evidence)

1. **No closed enums on `instanceSize` / `regionName` / `providerName`.** Atlas adds these continuously; closed enums create maintenance debt and may reject valid bodies. Approach A's bet is that the LLM reads `.describe()` hints + the API docs, not a curated taxonomy.
2. **Structure typed, leaves stringy.** `clusterType` is enum (closed by definition), booleans are typed, but instance/region/provider strings stay open. Maximal API faithfulness without sacrificing all LLM affordance.
3. **No defaults beyond what Atlas API itself defaults.** The LLM must be explicit about `terminationProtectionEnabled`, `backupEnabled`, etc. (Notable departure from `createFreeCluster.ts`, which hardcodes `terminationProtectionEnabled: false`.)
4. **`groupId` not duplicated in the body.** The path param routes the request; cloud-dev-captured payloads in [`hackathon-examples/`](../../../hackathon-examples/) confirm `groupId` is path-only. (`createFreeCluster.ts` includes it via cast — belt-and-suspenders that we drop.)
5. **`readOnlySpecs`, `analyticsSpecs`, `tags`, `pitEnabled`, `mongoDBMajorVersion` deliberately omitted.** Creation essentials only. case_8 ex1 has a deny rule on non-zero analytics/RO node counts — dropping the fields entirely makes them un-settable, strictly better for that suite.
6. **Top-level `autoScaling` not exposed.** Common LLM mistake; description repeats the per-region rule.

## Data flow

`execute(args)`:

1. Destructure args. Build the body inline:
   ```ts
   const body = {
     name,
     clusterType,
     replicationSpecs,
     ...(backupEnabled !== undefined && { backupEnabled }),
     ...(terminationProtectionEnabled !== undefined && {
       terminationProtectionEnabled,
     }),
   } as unknown as ClusterDescription20240805;
   ```
   `as unknown as ClusterDescription20240805` matches the `createFreeCluster.ts` pattern — needed because the openapi type has many `readonly` and union variants.
2. `await ensureCurrentIpInAccessList(this.apiClient, projectId);` — kept for connectivity-after-create UX. Approach-A purists could drop this and let the LLM call `atlas-create-access-list` separately; we explicitly accept the tiny philosophical cost for the practical demo win.
3. `const created = await this.apiClient.createCluster({ params: { path: { groupId: projectId } }, body });`
4. Return both a one-line summary and the full API response JSON, so the LLM can reason about post-create state:
   ```ts
   return {
     content: [
       {
         type: "text",
         text: `Cluster "${name}" requested in project ${projectId} (clusterType: ${clusterType}).`,
       },
       {
         type: "text",
         text: `Double check your access lists to enable your current IP.`,
       },
       { type: "text", text: JSON.stringify(created, null, 2) },
     ],
   };
   ```

## Error handling

Inherit `AtlasToolBase.handleError` unchanged. It already pretty-prints 401/402/403 with actionable next-step links and falls back to `ToolBase.handleError` (with secret redaction) for everything else. No tool-local error handling needed; throwing `ApiClientError` from inside `execute()` is the right shape.

## Telemetry

Inherit `AtlasToolBase.resolveTelemetryMetadata` unchanged. It already extracts `projectId` from args. No override.

## Registration

One line added to `src/tools/atlas/tools.ts`:

```ts
export { CreateClusterTool } from "./create/createCluster.js";
```

`AllTools` aggregates from these re-exports automatically.

## Confirmation / elicitation

Not added to `confirmationRequiredTools` in [`userConfig.ts`](../../../src/common/config/userConfig.ts). Cluster creation is reversible (delete) and we want the eval to flow without prompts. Existing `atlas-create-free-cluster` doesn't require confirmation either — consistent.

## Public-API surface

Adding a new tool class triggers an `api-extractor` diff. After implementation:

```bash
pnpm run update:api
git add api-extractor/reports/
```

Required for `pnpm run check` (and CI) to pass.

## Testing plan (priority order)

1. **Inspector smoke test (required-encouraged by the brief).** `set -a; source .env; set +a; pnpm run inspect`. Drive the tool from the Inspector UI for three scenarios mirrored from case_8:
   - **Dev (ex1):** REPLICASET, AWS US_EAST_1, 1 region config, M10, compute + disk autoscaling, no backup.
   - **Budget prod (ex3):** REPLICASET, AWS US_EAST_1, 1 region config, M30, compute + disk autoscaling, `backupEnabled: true`.
   - **HA prod (ex4):** REPLICASET, AWS, ≥3 distinct regions with ≥5 total electables, M30+, compute + disk autoscaling, `backupEnabled: true`.
     Confirm each cluster appears in the cloud-dev Atlas UI before declaring success.
2. **E2E via Claude Code (required-encouraged by the brief).** Wire the local `dist/esm/index.js` build into Claude Code via the snippet in [`HACKATHON.md`](../../../HACKATHON.md) §5.3. Drive each of the three case_8 scenarios with a natural-language prompt mirroring the eval prompts.
3. **Integration test under `tests/integration/tools/atlas/`** using `describeWithAtlas` + `withProject`. **Skipped for the 2-hour box** unless smoke + E2E land with substantial slack.

## Risks already known (carried from `plan.md`)

- **`.env` is not auto-loaded.** Workaround: `set -a; source .env; set +a; pnpm run inspect`. Same applies to integration test runs.
- **api-extractor diff** must be regenerated after adding the tool class.
- **Cold-start npx install (~90–120s)** will trip Claude Code's MCP timeout; build locally and point clients at `dist/esm/index.js`.

## Out-of-scope follow-ons (if time permits)

In rough priority order if the 2-hour clock has slack after smoke + E2E:

1. `atlas-update-cluster` mirroring `PATCH /api/atlas/v2/groups/{groupId}/clusters/{clusterName}` — would let the LLM honor the case_8 ex3/ex4 prompt's "pause the cluster" line (rego doesn't gate on it, but it's user-prompted behavior).
2. Add `pitEnabled`, `tags`, `mongoDBMajorVersion` to `argsShape` — broader API mirror, more eval coverage.
3. Integration test under `tests/integration/tools/atlas/clusters.test.ts`.

## Definition of done

- `src/tools/atlas/create/createCluster.ts` exists and matches this spec.
- `src/tools/atlas/tools.ts` re-exports `CreateClusterTool`.
- `pnpm run build` succeeds.
- `pnpm run check` succeeds (after `pnpm run update:api`).
- `pnpm run inspect` against cloud-dev creates each of the three case_8 scenarios; clusters visible in the cloud-dev Atlas UI.
- E2E run through Claude Code drives each scenario end-to-end via natural language.
- `plan.md` updated with results (any prompts that worked / failed, token counts if observable).
