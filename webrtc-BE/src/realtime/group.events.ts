import { publish as publishWebhook } from "../webhooks/events";
import User from "../models/userModel";
import MessageService from "../services/message.service";
import { GroupSummary } from "../services/group.service";
import { broadcastMessage } from "../services/call-session.service";
import { emitToUser, emitToUsers, notifyUserEverywhere, removeUserFromRoom } from "./io";
import { safeError } from "../utils/safe-log";

/**
 * Socket notifications for group membership changes. Shared by the socket gateway and the
 * legacy REST endpoints so both paths keep every client in sync.
 */

const memberIds = (group: GroupSummary) => group.members.map((m) => String((m as any)._id));

async function nameOf(userId: string): Promise<string> {
    const user = await User.findById(userId).select("username").lean();
    return user?.username || "Someone";
}

async function systemNotice(group: GroupSummary, actorId: string, content: string): Promise<void> {
    try {
        const message = await MessageService.postServiceMessage(group._id, actorId, "system", content);
        broadcastMessage(group._id, memberIds(group), message);
    } catch (error) {
        console.error("Failed to post group notice:", safeError(error));
    }
}

export function groupUpdated(group: GroupSummary): void {
    emitToUsers(memberIds(group), "group:updated", { groupId: group._id, group });
}

export async function membersAdded(group: GroupSummary, actorId: string, added: string[]): Promise<void> {
    groupUpdated(group);
    publishWebhook({ type: "conversation.members_added", conversationId: String(group._id), data: { conversationId: String(group._id), userIds: added.map(String), actorId: String(actorId) } });
    added.forEach((id) => emitToUser(id, "group:added", { groupId: group._id, group }));
    const names = await Promise.all(added.map(nameOf));
    await systemNotice(group, actorId, `${await nameOf(actorId)} added ${names.join(", ")}`);
}

export async function memberRemoved(group: GroupSummary, actorId: string, removedId: string): Promise<void> {
    publishWebhook({ type: "conversation.members_removed", conversationId: String(group._id), data: { conversationId: String(group._id), userIds: [String(removedId)], actorId: String(actorId), reason: "removed" } });
    // No more room broadcasts (messages, typing) for the removed user
    removeUserFromRoom(removedId, group._id);
    // Every tab / device of the removed user (not only the latest connection)
    notifyUserEverywhere(removedId, "group:removed", { groupId: group._id, reason: "removed" });
    groupUpdated(group);
    await systemNotice(group, actorId, `${await nameOf(actorId)} removed ${await nameOf(removedId)}`);
}

export async function memberLeft(groupId: string, group: GroupSummary | null, userId: string): Promise<void> {
    publishWebhook({ type: "conversation.members_removed", conversationId: String(groupId), data: { conversationId: String(groupId), userIds: [String(userId)], actorId: String(userId), reason: "left" } });
    removeUserFromRoom(userId, groupId);
    notifyUserEverywhere(userId, "group:removed", { groupId, reason: "left" });
    if (group) {
        groupUpdated(group);
        await systemNotice(group, userId, `${await nameOf(userId)} left`);
    }
}
