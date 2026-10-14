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
];

export async function runMigrations(): Promise<void> {
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
