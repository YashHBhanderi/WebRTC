import mongoose from "mongoose";
import { currentContext } from "./context";

/**
 * Records that copy their conversation's tenantId / scope (defence in depth). A copy can only go
 * wrong through raw writes or an interrupted backfill; this check finds them.
 *
 * Mismatch handling: a mismatched record is never "repaired" by the request path. Because scope
 * filters are fail-closed, a record whose tenantId disagrees with its conversation is simply not
 * visible in the conversation's context (it can't leak; it can go missing). Operators run this
 * check (migration ledger / script) and repair with fix=true, which copies the conversation's scope.
 */
export const DERIVED_MODELS = ["Message", "calls", "Meeting", "Recording", "Notification", "SavedMessage"] as const;

export interface ConsistencyReport {
    model: string;
    mismatched: number;
    orphaned: number;
    fixed: number;
    sampleIds: string[];
}

export async function checkScopeConsistency(options: { fix?: boolean; sample?: number } = {}): Promise<ConsistencyReport[]> {
    if (currentContext()?.kind !== "system") {
        throw new Error("checkScopeConsistency must run as system (runAsSystem)");
    }
    const conversations = mongoose.model("Conversation").collection.collectionName;
    const reports: ConsistencyReport[] = [];
    for (const name of DERIVED_MODELS) {
        const model = mongoose.model(name);
        // Raw aggregation on purpose: compares stored values across every workspace
        const rows = await model.collection.aggregate([
            { $match: { conversationId: { $type: "objectId" } } },
            { $lookup: { from: conversations, localField: "conversationId", foreignField: "_id", as: "c", pipeline: [{ $project: { tenantId: 1, scope: 1, externalParticipants: 1 } }] } },
            {
                $project: {
                    orphan: { $eq: [{ $size: "$c" }, 0] },
                    docTenant: { $ifNull: ["$tenantId", null] },
                    convTenant: { $ifNull: [{ $first: "$c.tenantId" }, null] },
                    docScope: { $ifNull: ["$scope", { $cond: [{ $ifNull: ["$tenantId", false] }, "tenant", "global"] }] },
                    convScope: { $ifNull: [{ $first: "$c.scope" }, { $cond: [{ $ifNull: [{ $first: "$c.tenantId" }, false] }, "tenant", "global"] }] },
                    docGuests: { $ifNull: ["$guestUserIds", []] },
                    convGuests: { $ifNull: [{ $first: "$c.externalParticipants" }, []] },
                },
            },
            {
                $addFields: {
                    // External records must carry exactly their conversation's guests
                    guestMismatch: { $and: [{ $eq: ["$convScope", "external"] }, { $not: [{ $setEquals: ["$docGuests", "$convGuests"] }] }] },
                },
            },
            { $match: { $or: [{ orphan: true }, { guestMismatch: true }, { $expr: { $ne: ["$docTenant", "$convTenant"] } }, { $expr: { $ne: ["$docScope", "$convScope"] } }] } },
        ]).toArray();
        const orphaned = rows.filter((r) => r.orphan);
        const mismatched = rows.filter((r) => !r.orphan);
        let fixed = 0;
        if (options.fix) {
            for (const r of mismatched) {
                const res = await model.collection.updateOne({ _id: r._id }, { $set: { tenantId: r.convTenant, scope: r.convScope, guestUserIds: r.convScope === "external" ? r.convGuests : [] } });
                fixed += res.modifiedCount;
            }
        }
        reports.push({
            model: name,
            mismatched: mismatched.length,
            orphaned: orphaned.length,
            fixed,
            sampleIds: mismatched.slice(0, options.sample ?? 20).map((r) => String(r._id)),
        });
    }
    return reports;
}
