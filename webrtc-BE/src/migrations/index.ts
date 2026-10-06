import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import Message from "../models/messageModel";
import Call from "../models/callModel";
import ConversationUserState from "../models/conversationUserStateModel";
import Block from "../models/blockModel";

/**
 * Additive, idempotent data migrations. Each runs once and is recorded in the
 * `migrations` collection; a re-run (or a crash halfway) is safe because every step only
 * fills in missing data and never deletes or overwrites existing values.
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
