import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import Message from "../models/messageModel";
import groupService from "./group.service";
import { getGroupForMember } from "./authorization.service";
import { AppError, NotFoundError } from "../utils/errors";
import { optionalString, requireObjectIds } from "../utils/validation";
import { publicFileUrl, releaseFile, releaseMessageFiles, storeUpload } from "./file.service";

/** $map that keeps only public user fields (no password hash / verification token). */
const publicUsers = (input: string) => ({
    $map: {
        input,
        as: "u",
        in: {
            _id: "$$u._id",
            username: "$$u.username",
            email: "$$u.email",
            avatar: "$$u.avatar",
            isOnline: "$$u.isOnline",
            lastSeen: "$$u.lastSeen",
            bio: "$$u.bio",
            status: "$$u.status",
        },
    },
});

/** This user's archive/clear state for each conversation (absent = defaults). */
const userStateLookup = (userId: mongoose.Types.ObjectId) => [
    {
        $lookup: {
            from: "conversation_user_states",
            let: { cid: "$_id" },
            pipeline: [
                { $match: { $expr: { $and: [{ $eq: ["$userId", userId] }, { $eq: ["$conversationId", "$$cid"] }] } } },
                { $project: { isArchived: 1, clearedAt: 1 } },
            ],
            as: "userState",
        },
    },
    { $addFields: { userState: { $arrayElemAt: ["$userState", 0] } } },
];

/** Visible messages for this user: not deleted and newer than their "clear chat" point. */
const visibleMessages = {
    $filter: {
        input: "$messagesData",
        as: "msg",
        cond: {
            $and: [
                { $ne: ["$$msg.isDeleted", true] },
                { $gt: ["$$msg.createdAt", { $ifNull: ["$userState.clearedAt", new Date(0)] }] },
            ],
        },
    },
};

const lastMessageFields = {
    _id: "$lastMessage._id",
    userId: "$lastMessage.userId",
    content: "$lastMessage.content",
    type: "$lastMessage.type",
    isRead: "$lastMessage.isRead",
    createdAt: "$lastMessage.createdAt",
};

const adminUnion = {
    $setUnion: [
        { $ifNull: ["$groupAdmins", []] },
        { $cond: [{ $ifNull: ["$groupAdmin", false] }, ["$groupAdmin"], []] },
    ],
};

export default class ConversationService {
    /** 1:1 chats with last message + unread count, newest first. `archived` selects the archive list. */
    public static async getUserConversations(userId: mongoose.Types.ObjectId, archived = false) {
        const objectId = new mongoose.Types.ObjectId(userId);

        return Conversation.aggregate([
            { $match: { members: objectId, isGroup: false } },
            ...userStateLookup(objectId),
            { $match: archived ? { "userState.isArchived": true } : { "userState.isArchived": { $ne: true } } },
            { $lookup: { from: "users", localField: "members", foreignField: "_id", as: "membersData" } },
            { $addFields: { membersData: publicUsers("$membersData") } },
            { $lookup: { from: "messages", localField: "messages", foreignField: "_id", as: "messagesData" } },
            { $addFields: { messagesData: visibleMessages } },
            {
                $addFields: {
                    lastMessage: {
                        $cond: {
                            if: { $gt: [{ $size: "$messagesData" }, 0] },
                            then: { $arrayElemAt: [{ $sortArray: { input: "$messagesData", sortBy: { createdAt: -1 } } }, 0] },
                            else: null,
                        },
                    },
                    unreadCount: {
                        $size: {
                            $filter: {
                                input: "$messagesData",
                                as: "msg",
                                cond: { $and: [{ $eq: ["$$msg.isRead", false] }, { $ne: ["$$msg.userId", objectId] }] },
                            },
                        },
                    },
                },
            },
            // Chats without any message are hidden, except ones the user cleared (they stay, empty)
            { $match: { $or: [{ lastMessage: { $ne: null } }, { "userState.clearedAt": { $ne: null } }] } },
            {
                $project: {
                    _id: 1,
                    unreadCount: 1,
                    isArchived: { $ifNull: ["$userState.isArchived", false] },
                    sender: {
                        $arrayElemAt: [{ $filter: { input: "$membersData", as: "member", cond: { $eq: ["$$member._id", objectId] } } }, 0],
                    },
                    receiver: {
                        $arrayElemAt: [{ $filter: { input: "$membersData", as: "member", cond: { $ne: ["$$member._id", objectId] } } }, 0],
                    },
                    lastMessage: { $cond: [{ $ne: ["$lastMessage", null] }, lastMessageFields, null] },
                    timestamp: { $ifNull: ["$lastMessage.createdAt", "$userState.clearedAt"] },
                },
            },
            { $sort: { timestamp: -1 } },
        ]);
    }

    public static async createOrGetConversation(userId: string, receiverId: string) {
        let conversation = await Conversation.findOne({ members: { $all: [userId, receiverId] }, isGroup: false });

        if (!conversation) {
            conversation = new Conversation({ members: [userId, receiverId], messages: [], timestamp: new Date() });
            await conversation.save();
        }
        return conversation;
    }

    public static async createGroupConversation(groupAdmin: string, groupMembers: string, groupName: unknown, groupDescription: unknown, file: Express.Multer.File | undefined) {
        // Validate everything before uploading, so a rejected request leaves no file behind
        let parsed: unknown;
        try {
            parsed = JSON.parse(groupMembers);
        } catch {
            throw new AppError("Members are invalid");
        }
        const memberIds = requireObjectIds(parsed, "groupMembers", 256);
        if (!memberIds.includes(String(groupAdmin))) {
            memberIds.push(String(groupAdmin));
        }
        const name = optionalString(groupName, "Group name", 100);
        if (!name || memberIds.length < 3) throw new AppError("A group must have a name and at least 2 members");
        const description = optionalString(groupDescription, "Description", 500) || "";
        if (!file) throw new AppError("Please choose a group photo");

        const groupId = new mongoose.Types.ObjectId();
        const { stored } = await storeUpload(file, { purpose: "group-avatar", groupId: String(groupId) }, String(groupAdmin));
        try {
            return await new Conversation({
                _id: groupId,
                members: memberIds,
                isGroup: true,
                groupName: name,
                groupAdmin,
                groupAdmins: [groupAdmin],
                groupAvatar: publicFileUrl(stored.storageKey),
                groupAvatarFile: stored,
                groupDescription: description,
            }).save();
        } catch (error) {
            await releaseFile(stored);
            throw error;
        }
    }

    /** Legacy REST path — same rules as the group:add-member socket event. */
    public static async addMembersInGroup(conversationId: string, currentUserId: string, userIds: string[]) {
        return groupService.addMembers(conversationId, currentUserId, userIds);
    }

    /** Groups with last message + unread count, newest first. `archived` selects the archive list. */
    public static async getUserGroupsConversations(userId: string, archived = false) {
        const userObjectId = new mongoose.Types.ObjectId(userId);
        return Conversation.aggregate([
            { $match: { members: userObjectId, isGroup: true } },
            ...userStateLookup(userObjectId),
            { $match: archived ? { "userState.isArchived": true } : { "userState.isArchived": { $ne: true } } },
            { $lookup: { from: "users", localField: "members", foreignField: "_id", as: "membersData" } },
            { $lookup: { from: "messages", localField: "messages", foreignField: "_id", as: "messagesData" } },
            { $addFields: { messagesData: visibleMessages } },
            {
                $addFields: {
                    lastMessage: {
                        $cond: {
                            if: { $gt: [{ $size: "$messagesData" }, 0] },
                            then: { $arrayElemAt: [{ $sortArray: { input: "$messagesData", sortBy: { createdAt: -1 } } }, 0] },
                            else: null,
                        },
                    },
                    unreadCount: {
                        $size: {
                            $filter: {
                                input: "$messagesData",
                                as: "msg",
                                cond: { $and: [{ $eq: ["$$msg.isRead", false] }, { $ne: ["$$msg.userId", userObjectId] }] },
                            },
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 1,
                    groupName: 1,
                    groupAvatar: 1,
                    groupDescription: 1,
                    groupAdmin: 1,
                    groupAdmins: adminUnion,
                    members: publicUsers("$membersData"),
                    unreadCount: 1,
                    isArchived: { $ifNull: ["$userState.isArchived", false] },
                    lastMessage: { $cond: [{ $ne: ["$lastMessage", null] }, lastMessageFields, null] },
                    timestamp: { $ifNull: ["$lastMessage.createdAt", "$createdAt"] },
                },
            },
            { $sort: { timestamp: -1 } },
        ]);
    }

    /** Group details for members only. */
    public static async getGroupInfo(conversationId: string, userId: string) {
        await getGroupForMember(conversationId, userId);
        const conversation = await Conversation.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(conversationId), isGroup: true } },
            { $lookup: { from: "users", localField: "groupAdmin", foreignField: "_id", as: "groupAdminDetails" } },
            { $lookup: { from: "users", localField: "members", foreignField: "_id", as: "membersDetails" } },
            {
                $project: {
                    groupName: 1,
                    groupAdmin: { $arrayElemAt: [publicUsers("$groupAdminDetails"), 0] },
                    groupAdmins: adminUnion,
                    groupAvatar: 1,
                    groupDescription: 1,
                    members: 1,
                    membersDetails: publicUsers("$membersDetails"),
                    timestamp: 1,
                },
            },
        ]);

        if (!conversation || conversation.length === 0) {
            throw new NotFoundError("Group conversation not found");
        }
        return conversation[0];
    }

    public static async deleteConversation(conversationId: string, userId: string) {
        const conversation = await Conversation.findById(conversationId);

        if (!conversation) {
            throw new Error("Conversation not found");
        }

        const isParticipant = conversation.members.some(member => member.toString() === userId);
        if (!isParticipant) {
            throw new Error("Unauthorized: You are not a member of this conversation");
        }

        const fileKeys = (await Message.find({ conversationId: conversation._id, "file.storageKey": { $exists: true } })
            .select("file.storageKey")
            .lean()).map((m) => m.file?.storageKey);
        if (conversation?.messages?.length) {
            await Message.deleteMany({ _id: { $in: conversation.messages } });
        }

        await Conversation.findByIdAndDelete(conversationId);
        // Stored attachments go too, unless a forwarded copy elsewhere still uses them
        await releaseMessageFiles(fileKeys);
        await releaseFile(conversation.groupAvatarFile);
    }

    /** Legacy REST path — same rules as the group:remove-member socket event. */
    public static async removeMemberFromGroup(conversationId: string, currentUserId: string, userId: string) {
        return groupService.removeMember(conversationId, currentUserId, userId);
    }

    public static async addReaction(messageId: string, userId: string, emoji: string) {
        const message = await Message.findById(messageId);
        if (!message) throw new Error("Message not found");

        const reactionIndex = message.reactions.findIndex(r => r.userId.toString() === userId);
        if (reactionIndex > -1) {
            if (message.reactions[reactionIndex].emoji === emoji) {
                message.reactions.splice(reactionIndex, 1);
            } else {
                message.reactions[reactionIndex].emoji = emoji;
            }
        } else {
            message.reactions.push({ userId: new mongoose.Types.ObjectId(userId) as any, emoji });
        }

        await message.save();
        return message;
    }
}
