import mongoose from "mongoose";
import ConversationUserState, { IConversationUserState } from "../models/conversationUserStateModel";

export interface ChatStateView {
    isArchived: boolean;
    archivedAt: Date | null;
    clearedAt: Date | null;
    isFavorite: boolean;
}

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

const view = (state: Partial<IConversationUserState> | null | undefined): ChatStateView => ({
    isArchived: !!state?.isArchived,
    archivedAt: state?.archivedAt || null,
    clearedAt: state?.clearedAt || null,
    isFavorite: !!state?.isFavorite,
});

/** Archive / clear chat / favorite — per user only; the other members never see these changes. */
class ChatStateService {
    async get(userId: string, conversationId: string): Promise<ChatStateView> {
        const state = await ConversationUserState.findOne({
            userId: toObjectId(userId),
            conversationId: toObjectId(conversationId),
        }).lean();
        return view(state);
    }

    async clearedAt(userId: string, conversationId: string): Promise<Date | null> {
        return (await this.get(userId, conversationId)).clearedAt;
    }

    private async set(userId: string, conversationId: string, fields: Record<string, unknown>): Promise<ChatStateView> {
        const state = await ConversationUserState.findOneAndUpdate(
            { userId: toObjectId(userId), conversationId: toObjectId(conversationId) },
            { $set: fields },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
        return view(state);
    }

    setArchived(userId: string, conversationId: string, archived: boolean): Promise<ChatStateView> {
        return this.set(userId, conversationId, { isArchived: archived, archivedAt: archived ? new Date() : null });
    }

    setFavorite(userId: string, conversationId: string, favorite: boolean): Promise<ChatStateView> {
        return this.set(userId, conversationId, { isFavorite: favorite, favoritedAt: favorite ? new Date() : null });
    }

    /** Which of these conversations this user marked as favorite. */
    async favoriteIds(userId: string, conversationIds: string[]): Promise<Set<string>> {
        if (!conversationIds.length) return new Set();
        const rows = await ConversationUserState.find({ userId: toObjectId(userId), conversationId: { $in: conversationIds.map(toObjectId) }, isFavorite: true })
            .select("conversationId").lean();
        return new Set(rows.map((r) => String(r.conversationId)));
    }

    /** Hide everything up to now for this user. Messages stay in the database for everyone else. */
    clear(userId: string, conversationId: string): Promise<ChatStateView> {
        return this.set(userId, conversationId, { clearedAt: new Date() });
    }
}

export default new ChatStateService();
