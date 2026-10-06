import mongoose from "mongoose";
import Conversation, { IConversation } from "../models/conversationModel";
import User from "../models/userModel";
import { adminIds, getGroupForAdmin, getGroupForMember, isMember } from "./authorization.service";
import { AppError, NotFoundError } from "../utils/errors";
import { attachGroupAvatar, publicFileUrl, releaseFile } from "./file.service";
import { optionalString, PUBLIC_USER_FIELDS, requireObjectId, requireObjectIds } from "../utils/validation";

const oid = (id: string) => new mongoose.Types.ObjectId(id);

export interface GroupSummary {
    _id: string;
    groupName?: string;
    groupDescription?: string;
    groupAvatar?: string;
    groupAdmins: string[];
    members: Record<string, unknown>[];
}

export interface GroupUpdateInput {
    groupName?: unknown;
    groupDescription?: unknown;
    /** Storage key returned by POST /upload (purpose=group-avatar) for this group. */
    groupAvatarKey?: unknown;
}

/**
 * Group membership and admin rules. Every method resolves the actor's rights from the
 * database; ids/roles in the request are only treated as targets.
 */
class GroupService {
    /** Group as clients render it: public member fields + admin ids. */
    async summary(groupId: string): Promise<GroupSummary> {
        const group = await Conversation.findById(groupId).select("-messages").lean();
        if (!group || !group.isGroup) {
            throw new NotFoundError("Group not found");
        }
        const members = await User.find({ _id: { $in: group.members } }).select(PUBLIC_USER_FIELDS).lean();
        // Keep the stored member order (used for admin succession)
        const order = new Map((group.members || []).map((m, i) => [String(m), i]));
        members.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
        return {
            _id: String(group._id),
            groupName: group.groupName,
            groupDescription: group.groupDescription,
            groupAvatar: group.groupAvatar,
            groupAdmins: [...adminIds(group as unknown as IConversation)],
            members: members as unknown as Record<string, unknown>[],
        };
    }

    async update(groupId: unknown, actorId: string, input: GroupUpdateInput): Promise<GroupSummary> {
        const group = await getGroupForAdmin(groupId, actorId);
        const set: Record<string, unknown> = {};
        const name = optionalString(input.groupName, "Group name", 100);
        if (name !== undefined) {
            if (!name) {
                throw new AppError("Group name cannot be empty");
            }
            set.groupName = name;
        }
        const description = optionalString(input.groupDescription, "Description", 500);
        if (description !== undefined) {
            set.groupDescription = description;
        }
        const avatar = input.groupAvatarKey ? await attachGroupAvatar(input.groupAvatarKey, String(group._id), actorId) : null;
        if (avatar) {
            set.groupAvatar = publicFileUrl(avatar.storageKey);
            set.groupAvatarFile = avatar;
        }
        if (!Object.keys(set).length) {
            throw new AppError("Nothing to update");
        }
        await Conversation.updateOne({ _id: group._id }, { $set: set });
        // Old photo goes only once the group points at the new one
        if (avatar && group.groupAvatarFile?.storageKey !== avatar.storageKey) {
            await releaseFile(group.groupAvatarFile);
        }
        return this.summary(String(group._id));
    }

    /** Returns the ids that were actually added (existing users who were not members yet). */
    async addMembers(groupId: unknown, actorId: string, userIds: unknown): Promise<{ group: GroupSummary; added: string[] }> {
        const group = await getGroupForAdmin(groupId, actorId);
        const requested = requireObjectIds(userIds, "userIds", 100);
        const candidates = requested.filter((id) => !isMember(group, id));
        if (!candidates.length) {
            throw new AppError("Those people are already members of this group");
        }
        const existing = await User.find({ _id: { $in: candidates } }).select("_id").lean();
        const added = existing.map((u) => String(u._id));
        if (!added.length) {
            throw new NotFoundError("Users not found");
        }
        await Conversation.updateOne({ _id: group._id }, { $addToSet: { members: { $each: added.map(oid) } } });
        return { group: await this.summary(String(group._id)), added };
    }

    async removeMember(groupId: unknown, actorId: string, memberId: unknown): Promise<GroupSummary> {
        const group = await getGroupForAdmin(groupId, actorId);
        const targetId = requireObjectId(memberId, "userId");
        if (targetId === String(actorId)) {
            throw new AppError("Use Leave group to remove yourself");
        }
        if (!isMember(group, targetId)) {
            throw new AppError("User is not a member of this group");
        }
        await this.detach(group, targetId);
        return this.summary(String(group._id));
    }

    async promoteAdmin(groupId: unknown, actorId: string, memberId: unknown): Promise<GroupSummary> {
        const group = await getGroupForAdmin(groupId, actorId);
        const targetId = requireObjectId(memberId, "userId");
        if (!isMember(group, targetId)) {
            throw new AppError("User is not a member of this group");
        }
        await Conversation.updateOne({ _id: group._id }, { $addToSet: { groupAdmins: oid(targetId) } });
        return this.summary(String(group._id));
    }

    async demoteAdmin(groupId: unknown, actorId: string, memberId: unknown): Promise<GroupSummary> {
        const group = await getGroupForAdmin(groupId, actorId);
        const targetId = requireObjectId(memberId, "userId");
        const admins = adminIds(group);
        if (!admins.has(targetId)) {
            throw new AppError("User is not an admin");
        }
        if (admins.size <= 1) {
            throw new AppError("A group needs at least one admin");
        }
        admins.delete(targetId);
        await this.writeAdmins(group, admins);
        return this.summary(String(group._id));
    }

    /**
     * Leave a group. If the last admin leaves, the earliest remaining member becomes admin so the
     * group is never left without one. History stays for everyone else.
     */
    async leave(groupId: unknown, userId: string): Promise<{ group: GroupSummary | null; remainingMembers: string[] }> {
        const group = await getGroupForMember(groupId, userId);
        await this.detach(group, userId);
        const after = await Conversation.findById(group._id).select("members").lean();
        const remaining = (after?.members || []).map(String);
        return { group: remaining.length ? await this.summary(String(group._id)) : null, remainingMembers: remaining };
    }

    /** Remove a member and keep the admin set valid (promote a successor if needed). */
    private async detach(group: IConversation, userId: string): Promise<void> {
        await Conversation.updateOne(
            { _id: group._id },
            { $pull: { members: oid(userId), groupAdmins: oid(userId) } }
        );
        const fresh = await Conversation.findById(group._id).select("members groupAdmins groupAdmin isGroup");
        if (!fresh) {
            return;
        }
        const remaining = (fresh.members || []).map(String);
        const admins = new Set([...adminIds(fresh)].filter((id) => remaining.includes(id)));
        if (!admins.size && remaining.length) {
            admins.add(remaining[0]);
        }
        await this.writeAdmins(fresh, admins);
    }

    /** groupAdmins is the source of truth; the legacy groupAdmin field follows the first admin. */
    private async writeAdmins(group: IConversation, admins: Set<string>): Promise<void> {
        const list = [...admins];
        await Conversation.updateOne(
            { _id: group._id },
            list.length
                ? { $set: { groupAdmins: list.map(oid), groupAdmin: oid(list[0]) } }
                : { $set: { groupAdmins: [] }, $unset: { groupAdmin: "" } }
        );
    }
}

export default new GroupService();
