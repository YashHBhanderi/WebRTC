import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import { v2 as cloudinary } from "cloudinary";
import Message from "../models/messageModel";
import User from "../models/userModel";

export default class ConversationService {
    public static async getUserConversations(userId: mongoose.Types.ObjectId) {

        const objectId = new mongoose.Types.ObjectId(userId);

        const conversations = await Conversation.aggregate([
            { $match: { members: objectId, isGroup: false } },

            {
                $lookup: {
                    from: "users",
                    localField: "members",
                    foreignField: "_id",
                    as: "membersData",
                },
            },
            {
                $lookup: {
                    from: "messages",
                    localField: "messages",
                    foreignField: "_id",
                    as: "messagesData",
                },
            },
            {
                $addFields: {
                    messagesData: {
                        $filter: {
                            input: "$messagesData",
                            as: "msg",
                            cond: {
                                $or: [
                                    { $eq: ["$$msg.isDeleted", false] },
                                    { $not: ["$$msg.isDeleted"] }
                                ]
                            }
                        }
                    }
                }
            },
            {
                $addFields: {
                    lastMessage: {
                        $cond: {
                            if: { $gt: [{ $size: "$messagesData" }, 0] },
                            then: {
                                $arrayElemAt: [
                                    {
                                        $sortArray: {
                                            input: "$messagesData",
                                            sortBy: { createdAt: -1 },
                                        },
                                    },
                                    0,
                                ],
                            },
                            else: null,
                        },
                    },
                    unreadCount: {
                        $size: {
                            $filter: {
                                input: "$messagesData",
                                as: "msg",
                                cond: {
                                    $and: [
                                        { $eq: ["$$msg.isRead", false] },
                                        { $ne: ["$$msg.userId", objectId] },
                                    ],
                                },
                            },
                        },
                    },
                },
            },
            {
                $match: {
                    lastMessage: { $ne: null },
                },
            },
            {
                $project: {
                    _id: 1,
                    unreadCount: 1,
                    sender: {
                        $arrayElemAt: [
                            {
                                $filter: {
                                    input: "$membersData",
                                    as: "member",
                                    cond: { $eq: ["$$member._id", objectId] },
                                },
                            },
                            0,
                        ],
                    },
                    receiver: {
                        $arrayElemAt: [
                            {
                                $filter: {
                                    input: "$membersData",
                                    as: "member",
                                    cond: { $ne: ["$$member._id", objectId] },
                                },
                            },
                            0,
                        ],
                    },
                    lastMessage: {
                        _id: "$lastMessage._id",
                        content: "$lastMessage.content",
                        type: "$lastMessage.type",
                        isRead: "$lastMessage.isRead",
                        createdAt: "$lastMessage.createdAt",
                    },
                    timestamp: { $ifNull: ["$lastMessage.createdAt", "$timestamp"] },
                },
            },
            {
                $sort: {
                    timestamp: -1,
                },
            },
        ]);

        return conversations;
    }
    
    public static async getMessagesByConversationId(conversationId: string, page: number = 1, limit: number = 20) {
        if (!conversationId) {
            throw new Error("Conversation ID is required");
        }
    
        const conversation = await Conversation.aggregate([
            {
                $match: { _id: new mongoose.Types.ObjectId(conversationId) }
            },
            {
                $lookup: {
                    from: "messages",
                    localField: "messages",
                    foreignField: "_id",
                    as: "messages"
                }
            },
            {
                $set: {
                    messages: {
                        $filter: {
                            input: "$messages",
                            as: "message",
                            cond: {
                                $or: [
                                    {
                                        $eq: [
                                            "$$message.isDeleted",
                                            false
                                        ]
                                    },
                                    {
                                        $eq: ["$$message.isDeleted", null]
                                    },
                                    {
                                        $eq: [
                                            "$$message.isDeleted",
                                            undefined
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            },
            {
                $unwind: {
                    path: "$messages",
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $sort: { "messages.createdAt": -1 }
            },
            {
                $skip: (page - 1) * limit
            },
            {
                $limit: limit
            },
            {
                $sort: { "messages.createdAt": 1 }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "messages.userId",
                    foreignField: "_id",
                    as: "messages.user"
                }
            },
            {
                $unwind: {
                    path: "$messages.user",
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $lookup: {
                    from: "messages",
                    localField: "messages.replyTo",
                    foreignField: "_id",
                    as: "messages.replyToData"
                }
            },
            {
                $unwind: {
                    path: "$messages.replyToData",
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $group: {
                    _id: "$_id",
                    createdAt: { $first: "$createdAt" },
                    messages: {
                        $push: {
                            $cond: {
                                if: { $gt: ["$messages._id", null] },
                                then: {
                                    _id: "$messages._id",
                                    content: "$messages.content",
                                    type: "$messages.type",
                                    fileUrl: "$messages.fileUrl",
                                    thumbnailUrl: { $ifNull: ["$messages.thumbnailUrl", "$messages.fileUrl"] },
                                    isDeleted: "$messages.isDeleted",
                                    createdAt: "$messages.createdAt",
                                    userId: "$messages.user._id",
                                    reactions: "$messages.reactions",
                                    user: {
                                        _id: "$messages.user._id",
                                        username: "$messages.user.username",
                                        email: "$messages.user.email",
                                        avatar: "$messages.user.avatar",
                                        isOnline: "$messages.user.isOnline",
                                        lastSeen: "$messages.user.lastSeen"
                                    },
                                    replyTo: {
                                        _id: "$messages.replyToData._id",
                                        content: "$messages.replyToData.content",
                                        type: "$messages.replyToData.type",
                                        userId: "$messages.replyToData.userId"
                                    }
                                },
                                else: "$$REMOVE"
                            }
                        }
                    }
                }
            }
        ]);
    
        if (!conversation || conversation.length === 0) {
            throw new Error("Conversation not found");
        }
    
        return conversation[0];
    } 

    public static async createOrGetConversation(userId: string, receiverId: string) {

        let conversation = await Conversation.findOne({ members: { $all: [userId, receiverId] }, isGroup: false, });

        if (!conversation) {
            conversation = new Conversation({ members: [userId, receiverId], messages: [], timestamp: new Date(), });
            await conversation.save();
        }
        return conversation;
    }

    public static async createGroupConversation(groupAdmin: string, groupMembers: string, groupName: string, groupDescription: string, file: Express.Multer.File | undefined) {
        if (!file) {
            throw new Error("No file uploaded");
        }
        const base64String = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
        const result = await cloudinary.uploader.upload(base64String, { folder: "uploads" });

        const jsonMember = JSON.parse(groupMembers);
        if (!jsonMember.includes(groupAdmin)) {
            jsonMember.push(groupAdmin);
        }

        if (!groupName || groupMembers.length < 2) throw new Error("A group must have a name and at least 2 members");

        const newConversation = new Conversation({
            members: jsonMember,
            isGroup: true,
            groupName,
            groupAdmin,
            groupAvatar: result.secure_url,
            groupDescription,
        });

        const savedConversation = await newConversation.save();
        return savedConversation;
    }

    public static async addMembersInGroup(conversationId: string, currentUserId: string, userIds: mongoose.Schema.Types.ObjectId[]) {
        const conversation = await Conversation.findById(conversationId);

        if (!conversation) throw new Error("Group conversation not found");

        if (!conversation.isGroup) throw new Error("This is not a group conversation");

        if (conversation?.groupAdmin?.toString() !== currentUserId) throw new Error("Only the group admin can add members");
        const alreadyAdded = userIds.filter((userId) => conversation.members.includes(userId));
        if (alreadyAdded.length > 0) {
            const existingUsers = await User.find({ _id: { $in: alreadyAdded } }).select('username');
            const existingUsernames = existingUsers.map((user) => user.username).join(', ');
            throw new Error(`Users ${existingUsernames} are already members of this group.`);
        }

        conversation.members.push(...userIds);
        await conversation.save();
        return conversation;
    }

    public static async getUserGroupsConversations(userId: string) {

        const userObjectId = new mongoose.Types.ObjectId(userId);
        const conversations = await Conversation.aggregate([
            {
                $match: {
                    members: userObjectId,
                    isGroup: true
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "members",
                    foreignField: "_id",
                    as: "membersData"
                }
            },
            {
                $lookup: {
                    from: "messages",
                    localField: "messages",
                    foreignField: "_id",
                    as: "messagesData"
                }
            },
            {
                $addFields: {
                    lastMessage: {
                        $cond: {
                            if: { $gt: [{ $size: "$messagesData" }, 0] },
                            then: {
                                $arrayElemAt: [
                                    {
                                        $sortArray: {
                                            input: "$messagesData",
                                            sortBy: { createdAt: -1 }
                                        }
                                    },
                                    0
                                ]
                            },
                            else: null
                        }
                    },
                    unreadCount: {
                        $size: {
                            $filter: {
                                input: "$messagesData",
                                as: "msg",
                                cond: {
                                    $and: [
                                        { $eq: ["$$msg.isRead", false] },
                                        { $ne: ["$$msg.userId", userObjectId] }
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 1,
                    groupName: 1,
                    groupAvatar: 1,
                    groupDescription: 1,
                    groupAdmin: 1,
                    members: "$membersData",
                    unreadCount: 1,
                    lastMessage: {
                        _id: "$lastMessage._id",
                        content: "$lastMessage.content",
                        type: "$lastMessage.type",
                        isRead: "$lastMessage.isRead",
                        createdAt: "$lastMessage.createdAt"
                    },
                    timestamp: {
                        $ifNull: ["$lastMessage.createdAt", "$timestamp"]
                    }
                }
            },
            { $sort: { "timestamp": -1 } }
        ]);
        return conversations;
    }

    public static async getGroupInfo(conversationId: string) {
        const conversation = await Conversation.aggregate([
            {
                $match: { _id: new mongoose.Types.ObjectId(conversationId) }
            },
            {
                $match: { isGroup: true }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "groupAdmin",
                    foreignField: "_id",
                    as: "groupAdminDetails"
                }
            },
            {
                $unwind: {
                    path: "$groupAdminDetails",
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "members",
                    foreignField: "_id",
                    as: "membersDetails"
                }
            },
            {
                $project: {
                    groupName: 1,
                    groupAdmin: "$groupAdminDetails",
                    groupAvatar: 1,
                    groupDescription: 1,
                    members: 1,
                    membersDetails: 1,
                    timestamp: 1
                }
            }
        ]);

        if (!conversation || conversation.length === 0)
            throw new Error("Group conversation not found");
        return conversation.shift();
    }

    public static async deleteConversation(conversationId: string, userId: string) {
        const conversation = await Conversation.findById(conversationId);
      
        if (!conversation) {
            throw new Error("Conversation not found");
        }
      
        const isParticipant = conversation.members.some(member =>
            member.toString() === userId
        );
        if (!isParticipant) {
            throw new Error("Unauthorized: You are not a member of this conversation");
        }

        if (conversation?.messages?.length) {
            await Message.deleteMany({ _id: { $in: conversation.messages } });
        }

        await Conversation.findByIdAndDelete(conversationId);
    }


    public static async removeMemberFromGroup(conversationId: string, currentUserId: string, userId: mongoose.Schema.Types.ObjectId) {
        const conversation = await Conversation.findById(conversationId);

        if (!conversation) throw new Error("Group conversation not found");
        if (!conversation.isGroup) throw new Error("This is not a group conversation");
        if (conversation?.groupAdmin?.toString() !== currentUserId) throw new Error("Only the group admin can remove members");
        if (!conversation.members.includes(userId)) throw new Error("User is not a member of this group");
        if (conversation.groupAdmin.toString() === userId.toString() && conversation.groupAdmin.toString() === currentUserId) throw new Error("You cannot remove the group admin or yourself from the group");

        conversation.members = conversation.members.filter((memberId) => memberId.toString() !== userId.toString());

        await conversation.save();
        return conversation;
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
    public static async getSharedMedia(conversationId: string) {
        return await Conversation.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(conversationId) } },
            {
                $lookup: {
                    from: "messages",
                    localField: "messages",
                    foreignField: "_id",
                    as: "allMessages"
                }
            },
            { $unwind: "$allMessages" },
            {
                $match: {
                    "allMessages.type": { $in: ['image', 'video', 'audio', 'pdf'] },
                    "allMessages.isDeleted": { $ne: true }
                }
            },
            { $sort: { "allMessages.createdAt": -1 } },
            {
                $project: {
                    _id: "$allMessages._id",
                    fileUrl: "$allMessages.fileUrl",
                    thumbnailUrl: { $ifNull: ["$allMessages.thumbnailUrl", "$allMessages.fileUrl"] },
                    type: "$allMessages.type",
                    createdAt: "$allMessages.createdAt"
                }
            }
        ]);
    }
}
