import { runAsSystem } from "../tenancy/context";
import { E2eeDevice, E2eeOneTimeKey, E2eeToDevice } from "../e2ee/models";
import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import User from "../models/userModel";
import Message from "../models/messageModel";
import Call from "../models/callModel";
import ConversationUserState from "../models/conversationUserStateModel";
import Block from "../models/blockModel";
import Notification from "../models/notificationModel";
import SavedMessage from "../models/savedMessageModel";
import Meeting from "../models/meetingModel";
import Recording from "../models/recordingModel";
import Tenant from "../models/tenantModel";
import TenantMembership from "../models/tenantMembershipModel";
import { checkScopeConsistency } from "../tenancy/consistency";
import { AppAuditEvent, AppCredential, AppGrant, AppUsage, ConsentRequest, DeveloperApp, RevokedToken } from "../developer/models";
import { WebhookDelivery, WebhookEndpoint } from "../webhooks/models";
import { JoinRequest, OrgAuditEvent, OrgInvitation, Team, TeamMembership } from "../organizations/models";

/**
 * Additive, idempotent data migrations. Each runs once and is recorded in the
 * `migrations` collection; a re-run (or a crash halfway) is safe because every step only
 * fills in missing data and never deletes anything. The one overwrite (avatar-storage-keys)
 * replaces a link derived from a stored key with that key.
 */
interface Migration {
    id: string;
    description: string;
    up: () => Promise<string>;
}

const migrations: Migration[] = [
    {
        id: "2026-10-06-message-conversation-id",
        description: "Backfill messages.conversationId from conversations.messages",
        up: async () => {
            let updated = 0;
            const cursor = Conversation.find({}).select("_id messages").lean().cursor();
            for await (const conversation of cursor) {
                const ids = (conversation.messages || []) as unknown[];
                for (let i = 0; i < ids.length; i += 1000) {
                    const result = await Message.updateMany(
                        { _id: { $in: ids.slice(i, i + 1000) }, conversationId: { $exists: false } },
                        { $set: { conversationId: conversation._id } }
                    );
                    updated += result.modifiedCount;
                }
            }
            return `${updated} message(s) linked to their conversation`;
        },
    },
    {
        id: "2026-10-06-group-admins",
        description: "Backfill conversations.groupAdmins from the single groupAdmin",
        up: async () => {
            const result = await Conversation.updateMany(
                {
                    isGroup: true,
                    groupAdmin: { $ne: null },
                    $or: [{ groupAdmins: { $exists: false } }, { groupAdmins: { $size: 0 } }],
                },
                [{ $set: { groupAdmins: ["$groupAdmin"] } }]
            );
            return `${result.modifiedCount} group(s) updated`;
        },
    },
    {
        id: "2026-10-06-indexes",
        description: "Create indexes used by history, search, lists, archive and block queries",
        up: async () => {
            // createIndexes() only adds missing indexes; it never drops existing ones
            await Promise.all([
                Message.createIndexes(),
                Conversation.createIndexes(),
                Call.createIndexes(),
                ConversationUserState.createIndexes(),
                Block.createIndexes(),
            ]);
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-07-message-file-index",
        description: "Index messages.file.storageKey (attachment reference counting)",
        up: async () => {
            await Message.createIndexes();
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-08-avatar-storage-keys",
        description: "Store S3 keys instead of /api/files/... links in users.avatar and conversations.groupAvatar",
        up: async () => {
            // The stored-file reference is the source of truth; only the derived link is replaced
            const users = await User.updateMany(
                { "avatarFile.storageKey": { $type: "string" }, $expr: { $ne: ["$avatar", "$avatarFile.storageKey"] } },
                [{ $set: { avatar: "$avatarFile.storageKey" } }]
            );
            const groups = await Conversation.updateMany(
                { "groupAvatarFile.storageKey": { $type: "string" }, $expr: { $ne: ["$groupAvatar", "$groupAvatarFile.storageKey"] } },
                [{ $set: { groupAvatar: "$groupAvatarFile.storageKey" } }]
            );
            return `${users.modifiedCount} user(s), ${groups.modifiedCount} group(s) updated`;
        },
    },
    {
        id: "2026-10-08-user-clerk-id",
        description: "Unique index on users.clerkId (Clerk sign-in link)",
        up: async () => {
            await User.createIndexes();
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-13-read-cursors",
        description: "Backfill per-user read/delivery cursors from the legacy messages.isRead flag",
        up: async () => {
            // Newest message each author had read by others, per chat
            const readByAuthor = await Message.aggregate([
                { $match: { isRead: true, conversationId: { $exists: true } } },
                { $group: { _id: { c: "$conversationId", a: "$userId" }, at: { $max: "$createdAt" } } },
            ]);
            const byConversation = new Map<string, { author: string; at: Date }[]>();
            for (const row of readByAuthor) {
                const key = String(row._id.c);
                const list = byConversation.get(key) || [];
                list.push({ author: String(row._id.a), at: row.at });
                byConversation.set(key, list);
            }
            let written = 0;
            const ids = [...byConversation.keys()];
            for (let i = 0; i < ids.length; i += 500) {
                const conversations = await Conversation.find({ _id: { $in: ids.slice(i, i + 500) } }).select("members").lean();
                const ops: any[] = [];
                for (const c of conversations) {
                    const rows = byConversation.get(String(c._id)) || [];
                    for (const member of (c.members || []).map(String)) {
                        // A member has read up to the newest read message written by someone else
                        const at = rows.filter((r) => r.author !== member).reduce<Date | null>((max, r) => (!max || r.at > max ? r.at : max), null);
                        if (at) {
                            ops.push({
                                updateOne: {
                                    filter: { userId: new mongoose.Types.ObjectId(member), conversationId: c._id },
                                    update: { $max: { lastReadAt: at, lastDeliveredAt: at } },
                                    upsert: true,
                                },
                            });
                        }
                    }
                }
                if (ops.length) {
                    const res = await ConversationUserState.bulkWrite(ops);
                    written += res.upsertedCount + res.modifiedCount;
                }
            }
            return `${written} read cursor(s) written`;
        },
    },
    {
        id: "2026-10-13-activity-saved-indexes",
        description: "Indexes for notifications (incl. 90-day expiry), saved messages and message mentions",
        up: async () => {
            await Promise.all([Notification.createIndexes(), SavedMessage.createIndexes(), Message.createIndexes()]);
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-13-meetings-indexes",
        description: "Indexes for scheduled meetings (code, calendar, chat)",
        up: async () => {
            await Meeting.createIndexes();
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-13-recordings-indexes",
        description: "Indexes for meeting recordings",
        up: async () => {
            await Recording.createIndexes();
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-14-recording-status-names",
        description: "Recording / transcript status 'ready' → 'completed'; interrupted 'starting' → 'failed'",
        up: async () => {
            const col = Recording.collection;
            const ready = await col.updateMany({ status: "ready" }, { $set: { status: "completed" } });
            const starting = await col.updateMany({ status: "starting" }, { $set: { status: "failed", error: "The recording was interrupted." } });
            const transcripts = await col.updateMany({ transcriptStatus: "ready" }, { $set: { transcriptStatus: "completed" } });
            return `${ready.modifiedCount} completed, ${starting.modifiedCount} failed, ${transcripts.modifiedCount} transcripts renamed`;
        },
    },
    {
        id: "2026-10-13-call-history-index",
        description: "Index calls by participant (call history)",
        up: async () => {
            await Call.createIndexes();
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-20-tenancy-foundation",
        description: "Multi-tenancy: tenant / membership collections and tenantId indexes (no data is rewritten)",
        up: async () => {
            // Existing data stays global: a missing tenantId reads as null (= global) in every
            // scope filter, so nothing is backfilled and nothing is assigned to a workspace.
            await Tenant.createIndexes();
            await TenantMembership.createIndexes();
            for (const model of [Conversation, Call, Meeting, Recording, Notification, SavedMessage] as any[]) {
                await model.createIndexes();
            }
            // Verification: before tenancy no record can belong to a workspace
            const scoped = await Conversation.countDocuments({ tenantId: { $nin: [null] } });
            return `indexes ensured; conversations already in a workspace: ${scoped}`;
        },
    },
    {
        id: "2026-10-21-message-scope",
        description: "Messages carry their conversation's tenantId/scope (backfill workspace chats only) + consistency report",
        up: async () => {
            await Message.createIndexes();
            // Legacy messages of global chats need nothing (missing tenantId = global). Only chats that
            // already belong to a workspace / are external get their messages stamped.
            let stamped = 0;
            const cursor = Conversation.find({ tenantId: { $nin: [null] } }).select("_id tenantId scope").lean().cursor();
            for await (const c of cursor) {
                const res = await Message.collection.updateMany(
                    { conversationId: c._id, $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
                    { $set: { tenantId: c.tenantId, scope: c.scope || "tenant" } },
                );
                stamped += res.modifiedCount;
            }
            const report = await checkScopeConsistency();
            const issues = report.filter((r) => r.mismatched || r.orphaned).map((r) => `${r.model}: ${r.mismatched} mismatched, ${r.orphaned} orphaned`);
            return `${stamped} message(s) stamped; consistency: ${issues.length ? issues.join("; ") : "no mismatches"}`;
        },
    },
    {
        id: "2026-10-22-external-guest-lists",
        description: "External conversation records carry their guest list (Phase 4B isolation); repair scope copies",
        up: async () => {
            // Records of external conversations without guestUserIds would be hidden from guests
            // (fail closed); copy the conversation's guests onto them. Also repairs any scope drift.
            const report = await checkScopeConsistency({ fix: true });
            const touched = report.filter((r) => r.mismatched || r.orphaned).map((r) => `${r.model}: ${r.fixed} fixed, ${r.orphaned} orphaned`);
            return touched.length ? touched.join("; ") : "nothing to fix";
        },
    },
    {
        id: "2026-10-28-saved-message-scope",
        description: "Saved messages made in an organization were stored as personal (upsert skipped the scope hook): re-derive each record's scope from its conversation. Updates scope fields only; nothing is deleted",
        up: async () => {
            const report = await checkScopeConsistency({ fix: true });
            const touched = report.filter((r) => r.mismatched || r.orphaned).map((r) => `${r.model}: ${r.fixed} fixed, ${r.orphaned} orphaned`);
            return touched.length ? touched.join("; ") : "nothing to fix";
        },
    },
    {
        id: "2026-10-28-e2ee",
        description: "End-to-end encryption: device keys (unique per user+device), one-time prekeys (unique, consumed once), device-message queue (TTL, retry-safe unique). Index-only; existing messages are not touched",
        up: async () => {
            for (const model of [E2eeDevice, E2eeOneTimeKey, E2eeToDevice] as any[]) {
                await model.createIndexes();
            }
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-27-organizations",
        description: "SpreeWe-managed organizations: indexes for tenants (unique slug), invitations, join requests, audit, teams, team memberships, channel lookup. No data changes: existing tenants stay Clerk-managed",
        up: async () => {
            for (const model of [Tenant, TenantMembership, OrgInvitation, JoinRequest, OrgAuditEvent, Team, TeamMembership, Conversation] as any[]) {
                await model.createIndexes();
            }
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-24-webhooks-and-consent",
        description: "Outbound webhook endpoints / deliveries (unique endpoint+event, TTL) and consent requests (TTL)",
        up: async () => {
            for (const model of [WebhookEndpoint, WebhookDelivery, ConsentRequest] as any[]) {
                await model.createIndexes();
            }
            return "indexes ensured";
        },
    },
    {
        id: "2026-10-23-developer-platform",
        description: "Developer platform collections: apps, credentials, grants, revoked tokens (TTL), usage (unique per day), audit",
        up: async () => {
            // Unique indexes carry correctness here (one credential per keyId, one grant per app+user,
            // one usage row per app+day), so they are built explicitly before the feature is used
            for (const model of [DeveloperApp, AppCredential, AppGrant, RevokedToken, AppUsage, AppAuditEvent] as any[]) {
                await model.createIndexes();
            }
            return "indexes ensured";
        },
    },
    {
        id: "2026-11-16-app-tenants",
        description: "Application tenants and app-managed users: partial unique indexes on tenants.clerkOrgId and users.email, new indexes",
        up: async () => {
            // Application tenants have no Clerk organization and app-managed users have no account email.
            // Both old indexes were unique over ALL documents (a missing value counts as null), which
            // would allow only one of each. Replace them with indexes that are unique among the
            // documents that have a value: existing data satisfies the new index because it satisfied
            // the old one. Nothing is deleted or rewritten.
            const replaced: string[] = [];
            for (const [model, name] of [[Tenant, "clerkOrgId_1"], [User, "email_1"]] as [mongoose.Model<any>, string][]) {
                const existing = (await model.collection.indexes().catch(() => [])).find((i) => i.name === name);
                if (existing && !(existing as any).partialFilterExpression) {
                    await model.collection.dropIndex(name);
                    replaced.push(`${model.collection.collectionName}.${name}`);
                }
                // Recreated at once (unique, partial), together with the model's new indexes
                await model.createIndexes();
            }
            for (const model of [TenantMembership, DeveloperApp, AppGrant, AppUsage] as mongoose.Model<any>[]) {
                await model.createIndexes();
            }
            // Explicit values for the new fields (absent already means the same thing)
            const apps = await DeveloperApp.updateMany({ dedicatedTenant: { $exists: false } }, { $set: { dedicatedTenant: false } });
            const tenants = await Tenant.updateMany({ kind: { $exists: false } }, { $set: { kind: "organization" } });
            // Existing apps are left as they are: global apps (consent / OAuth with SpreeWe accounts) and
            // workspace apps keep working. Only apps created from now on get a dedicated tenant.
            return `${replaced.length ? `replaced ${replaced.join(", ")}` : "indexes already current"}; ${apps.modifiedCount} app(s) marked legacy, ${tenants.modifiedCount} tenant(s) marked organization`;
        },
    },
];

export async function runMigrations(): Promise<void> {
    // Explicit system scope: migrations read and write every workspace
    return runAsSystem(() => applyMigrations(), "migrations");
}

async function applyMigrations(): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) {
        throw new Error("Database is not connected");
    }
    const ledger = db.collection<{ _id: string; description: string; appliedAt: Date; result: string }>("migrations");
    for (const migration of migrations) {
        if (await ledger.findOne({ _id: migration.id })) {
            continue;
        }
        const started = Date.now();
        console.log(`[migrations] ${migration.id}: ${migration.description}…`);
        const result = await migration.up();
        await ledger.insertOne({ _id: migration.id, description: migration.description, appliedAt: new Date(), result });
        console.log(`[migrations] ${migration.id}: ${result} (${Date.now() - started} ms)`);
    }
}
