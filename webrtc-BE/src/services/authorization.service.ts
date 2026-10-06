import Conversation, { IConversation } from "../models/conversationModel";
import { ForbiddenError, NotFoundError } from "../utils/errors";
import { requireObjectId } from "../utils/validation";

/**
 * Server-side permission checks shared by REST controllers and socket gateways.
 * Never trust ids/roles from the client — always resolve them here.
 */

/** Admin ids of a group: groupAdmins plus the legacy single groupAdmin field. */
export function adminIds(conversation: Pick<IConversation, "groupAdmin" | "groupAdmins">): Set<string> {
    const ids = new Set<string>((conversation.groupAdmins || []).map(String));
    if (conversation.groupAdmin) {
        ids.add(String(conversation.groupAdmin));
    }
    return ids;
}

export function isMember(conversation: Pick<IConversation, "members">, userId: string): boolean {
    return (conversation.members || []).some((m) => String(m) === String(userId));
}

export function isGroupAdmin(conversation: IConversation, userId: string): boolean {
    return !!conversation.isGroup && adminIds(conversation).has(String(userId));
}

/** Conversation the user belongs to, or 404/403. */
export async function getConversationForMember(conversationId: unknown, userId: string): Promise<IConversation> {
    const id = requireObjectId(conversationId, "conversationId");
    const conversation = await Conversation.findById(id).select("-messages");
    if (!conversation) {
        throw new NotFoundError("Conversation not found");
    }
    if (!isMember(conversation, userId)) {
        throw new ForbiddenError("You are not a member of this conversation");
    }
    return conversation;
}

export async function getGroupForMember(groupId: unknown, userId: string): Promise<IConversation> {
    const group = await getConversationForMember(groupId, userId);
    if (!group.isGroup) {
        throw new NotFoundError("Group not found");
    }
    return group;
}

export async function getGroupForAdmin(groupId: unknown, userId: string): Promise<IConversation> {
    const group = await getGroupForMember(groupId, userId);
    if (!isGroupAdmin(group, userId)) {
        throw new ForbiddenError("Only group admins can do this");
    }
    return group;
}

/** The other participant of a 1:1 conversation. */
export function directPeerId(conversation: IConversation, userId: string): string | null {
    if (conversation.isGroup) {
        return null;
    }
    const other = (conversation.members || []).map(String).find((m) => m !== String(userId));
    return other || null;
}
