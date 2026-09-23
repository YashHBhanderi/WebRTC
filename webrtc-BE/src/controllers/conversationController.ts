import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import mongoose from "mongoose";
import ConversationService from "../services/conversationService";
export default class ConversationController {
    static async getUserConversations(req: Request, res: Response): Promise<void> {
        const userId = new mongoose.Types.ObjectId((req as CustomRequest).userId);
        try {
            if (!userId) throw new Error("userId Is required");
            const conversations = await ConversationService.getUserConversations(userId);
            res.status(200).json({ success: true, data: conversations });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }


    static async getMessagesByConversationId(req: Request, res: Response): Promise<void> {
        const { conversationId } = req.params;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        try {
            if (!conversationId) throw new Error("Conversation ID is required");
            const conversation = await ConversationService.getMessagesByConversationId(conversationId, page, limit);
            res.status(200).json({ success: true, message: "Messages retrieved successfully", data: conversation.messages });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    static async createOrGetConversation(req: Request, res: Response): Promise<void> {
        const userId = (req as CustomRequest).userId;
        const { receiverId } = req.body;
        try {
            if (!receiverId) throw new Error("Receiver ID is required");
            if (!userId) throw new Error("userId Is required");
            const conversation = await ConversationService.createOrGetConversation(userId, receiverId);
            res.json({ conversationId: conversation._id });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    static async createGroupConversation(req: Request, res: Response): Promise<void> {
        const { groupMembers, groupName, groupDescription } = req.body;
        const groupAdmin = (req as CustomRequest).userId;
        const file = req.file;
        try {
            if (!groupMembers || !groupAdmin) throw new Error("Members are required Or Group Admin required!");
            const savedConversation = await ConversationService.createGroupConversation(groupAdmin, groupMembers, groupName, groupDescription, file);
            res.status(201).json({ status: true, data: savedConversation, message: 'Group Conversation created Successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });

        }
    }

    static async addMembersInGroup(req: Request, res: Response): Promise<void> {
        const { userIds } = req.body;
        const currentUserId = (req as CustomRequest).userId;
        const conversationId = req.params.id;
        try {
            if (!currentUserId) throw new Error("Current User required!");
            if (!Array.isArray(userIds) || userIds.length === 0) {
                throw new Error("userIds must be a non-empty array");
            }

            const conversation = await ConversationService.addMembersInGroup(conversationId, currentUserId, userIds)
            res.status(200).json({ status: true, data: conversation, message: 'Member Added Successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });

        }
    }

    static async getUserGroupsConversations(req: Request, res: Response) : Promise<void> {
        const userId = (req as CustomRequest).userId;
        try {
            if (!userId) throw new Error("Current User required!");
            const conversations = await ConversationService.getUserGroupsConversations(userId);
            res.status(200).json({ success: true, data: conversations, message: 'Grop chats get Successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    static async getGroupInfo(req: Request, res: Response) {
        const conversationId = req.params.id;
        try {
            const conversation = await ConversationService.getGroupInfo(conversationId);
            if (!conversation || conversation.length === 0) throw new Error('Group conversation not found');
            res.status(200).json({ status: true, data: conversation, message: 'Data get Successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    static async deleteConversation(req: Request, res: Response): Promise<void> {
        const { conversationId } = req.params;
        const userId = (req as CustomRequest).userId;
        try {
            if (!conversationId) throw new Error("Conversation ID is required");
            if (!userId) throw new Error("User ID is required");
            const conversation = await ConversationService.deleteConversation(conversationId, userId);
            res.status(200).json({ status: true, data: null, message: 'Conversation deleted successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    static async removeMemberFromGroup(req: Request, res: Response): Promise<void> {
        const { userId } = req.body;
        const currentUserId = (req as CustomRequest).userId;
        const conversationId = req.params.id;
        try {
            if (!currentUserId) throw new Error("Current User required!");

            const conversation = await ConversationService.removeMemberFromGroup(conversationId, currentUserId, userId );

            res.status(200).json({ status: true, data: conversation, message: "Member removed successfully" });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(", ") });
        }
    }

    static async getSharedMedia(req: Request, res: Response): Promise<void> {
        try {
            const { conversationId } = req.params;
            if (!conversationId) throw new Error("Conversation ID is required");
            const media = await ConversationService.getSharedMedia(conversationId);
            res.status(200).json({ status: true, data: media, message: 'Shared media retrieved successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: error.message });
        }
    }
}
