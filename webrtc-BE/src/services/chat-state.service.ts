import mongoose from "mongoose";
import ConversationUserState from "../models/conversationUserStateModel";

export interface ChatStateView {
    isArchived: boolean;
    archivedAt: Date | null;
    clearedAt: Date | null;
}

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

/** Archive / clear chat — per user only; the other members never see these changes. */
class ChatStateService {
    async get(userId: string, conversationId: string): Promise<ChatStateView> {
        const state = await ConversationUserState.findOne({
            userId: toObjectId(userId),
            conversationId: toObjectId(conversationId),
        }).lean();
        return {
            isArchived: !!state?.isArchived,
            archivedAt: state?.archivedAt || null,
            clearedAt: state?.clearedAt || null,
        };
    }

    async clearedAt(userId: string, conversationId: string): Promise<Date | null> {
        return (await this.get(userId, conversationId)).clearedAt;
    }

    async setArchived(userId: string, conversationId: string, archived: boolean): Promise<ChatStateView> {
        const state = await ConversationUserState.findOneAndUpdate(
            { userId: toObjectId(userId), conversationId: toObjectId(conversationId) },
            { $set: { isArchived: archived, archivedAt: archived ? new Date() : null } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
        return { isArchived: !!state?.isArchived, archivedAt: state?.archivedAt || null, clearedAt: state?.clearedAt || null };
    }

    /** Hide everything up to now for this user. Messages stay in the database for everyone else. */
    async clear(userId: string, conversationId: string): Promise<ChatStateView> {
        const state = await ConversationUserState.findOneAndUpdate(
            { userId: toObjectId(userId), conversationId: toObjectId(conversationId) },
            { $set: { clearedAt: new Date() } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
        return { isArchived: !!state?.isArchived, archivedAt: state?.archivedAt || null, clearedAt: state?.clearedAt || null };
    }
}

export default new ChatStateService();
