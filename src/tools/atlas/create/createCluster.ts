import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

export class CreateClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-cluster";
    public description =
        "Create a MongoDB Atlas cluster. Mirrors POST /api/atlas/v2/groups/{groupId}/clusters " +
        "(Atlas Admin API, Independent Shard Scaling format). Use for paid (M10+) replica set, " +
        "sharded, or geosharded clusters; for free-tier (M0/TENANT) clusters atlas-create-free-cluster " +
        "is a simpler alternative. autoScaling lives on each regionConfigs[] entry, not at the top " +
        "level. SHARDED clusters use one replicationSpecs[] entry per shard (no numShards field).";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe(
            "Atlas project ID. Mirrors {groupId} in POST /api/atlas/v2/groups/{groupId}/clusters."
        ),
        name: AtlasArgs.clusterName().describe("Cluster name."),
        clusterType: z.enum(["REPLICASET", "SHARDED", "GEOSHARDED"]).describe("Cluster topology type."),
        replicationSpecs: z
            .array(
                z.object({
                    zoneName: z
                        .string()
                        .optional()
                        .describe("Zone name. Required for GEOSHARDED. Conventional value: 'Zone 1'."),
                    regionConfigs: z
                        .array(
                            z.object({
                                providerName: z.string().describe("AWS | AZURE | GCP | TENANT (TENANT = free/flex)."),
                                backingProviderName: z
                                    .string()
                                    .optional()
                                    .describe("Required when providerName is TENANT (the underlying cloud)."),
                                regionName: z.string().describe("Cloud region, e.g. 'US_EAST_1'."),
                                priority: z
                                    .number()
                                    .int()
                                    .min(0)
                                    .max(7)
                                    .optional()
                                    .describe("Region priority. 7 = primary; required for dedicated tiers (M10+)."),
                                electableSpecs: z
                                    .object({
                                        instanceSize: z.string().describe("e.g. 'M10', 'M30'."),
                                        nodeCount: z
                                            .number()
                                            .int()
                                            .min(0)
                                            .optional()
                                            .describe(
                                                "Typically 3 for replica sets. Required for dedicated; omit for TENANT."
                                            ),
                                    })
                                    .optional(),
                                autoScaling: z
                                    .object({
                                        compute: z
                                            .object({
                                                enabled: z.boolean(),
                                                scaleDownEnabled: z.boolean().optional(),
                                                minInstanceSize: z
                                                    .string()
                                                    .optional()
                                                    .describe("Required when scaleDownEnabled is true."),
                                                maxInstanceSize: z
                                                    .string()
                                                    .optional()
                                                    .describe("Required when compute.enabled is true."),
                                            })
                                            .optional(),
                                        diskGB: z.object({ enabled: z.boolean() }).optional(),
                                    })
                                    .optional()
                                    .describe(
                                        "Per-region autoscaling. Lives on EACH regionConfigs entry, not top-level."
                                    ),
                            })
                        )
                        .describe("Per-region node configs within this replication spec / shard."),
                })
            )
            .describe(
                "One entry for replica sets; one per shard for SHARDED " + "(Independent Shard Scaling — no numShards)."
            ),
        backupEnabled: z.boolean().optional(),
        terminationProtectionEnabled: z.boolean().optional(),
    };

    protected async execute({
        projectId,
        name,
        clusterType,
        replicationSpecs,
        backupEnabled,
        terminationProtectionEnabled,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const body = {
            name,
            clusterType,
            replicationSpecs,
            backupEnabled,
            terminationProtectionEnabled,
        } as unknown as ClusterDescription20240805;

        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        const created = await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${name}" requested in project ${projectId} (clusterType: ${clusterType}).`,
                },
                { type: "text", text: `Double check your access lists to enable your current IP.` },
                { type: "text", text: JSON.stringify(created, null, 2) },
            ],
        };
    }
}
