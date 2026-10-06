import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import mongoose from "mongoose";
import ConversationService from "../services/conversationService";
import MessageService from "../services/message.service";
import chatState from "../services/chat-state.service";
import blockService from "../services/block.service";
import { directPeerId, getConversationForMember } from "../services/authorization.service";
import { memberRemoved, membersAdded } from "../realtime/group.events";
import { AppError } from "../utils/errors";
import { discardTempFile } from "../utils/multer";

/** Same error body as before; status 4xx for expected failures, 500 otherwise. */
function fail(res: Response, error: unknown): void {
    const status = error instanceof AppError ? error.status : 500;
    res.status(status).json({ status: false, data: null, message: error instanceof Error ? error.message : "Something went wrong" });
}

const archivedFlag = (req: Request) => req.query.archived === "true" || req.query.archived === "1";

export default class ConversationController {
    static async getUserConversations(req: Request, res: Response): Promise<void> {
        try {
            const userId = new mongoose.Types.ObjectId((req as CustomRequest).userId);
            const conversations = await ConversationService.getUserConversations(userId, archivedFlag(req));
            res.status(200).json({ success: true, data: conversations });
        } catch (error) {
            fail(res, error);
        }
    }

    static async getMessagesByConversationId(req: Request, res: Response): Promise<void> {
        const { conversationId } = req.params;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        try {
            const messages = await MessageService.history(conversationId, (req as CustomRequest).userId!, page, limit);
            res.status(200).json({ success: true, message: "Messages retrieved successfully", data: messages });
        } catch (error) {
            fail(res, error);
        }
    }

    /** GET /messages/:conversationId/search?q=&before=&beforeId=&limit= */
    static async searchMessages(req: Request, res: Response): Promise<void> {
        try {
            const result = await MessageService.search(
                req.params.conversationId,
                (req as CustomRequest).userId!,
                req.query.q,
                { before: req.query.before as string | undefined, beforeId: req.query.beforeId as string | undefined },
                parseInt(req.query.limit as string) || 30
            );
            res.status(200).json({ success: true, data: result });
        } catch (error) {
            fail(res, error);
        }
    }

    /** GET /messages/:conversationId/position/:messageId — how many newer messages to load to reach it. */
    static async messagePosition(req: Request, res: Response): Promise<void> {
        try {
            const data = await MessageService.position(req.params.conversationId, (req as CustomRequest).userId!, req.params.messageId);
            res.status(200).json({ success: true, data });
        } catch (error) {
            fail(res, error);
        }
    }

    /** GET /conversations/:conversationId/state — this user's archive/clear/block state for the chat. */
    static async getChatState(req: Request, res: Response): Promise<void> {
        try {
            const userId = (req as CustomRequest).userId!;
            const conversation = await getConversationForMember(req.params.conversationId, userId);
            const state = await chatState.get(userId, String(conversation._id));
            const peerId = directPeerId(conversation, userId);
            res.status(200).json({
                success: true,
                data: {
                    ...state,
                    isGroup: !!conversation.isGroup,
                    peerId,
                    // Only the user's own block is revealed, never whether the other side blocked them
                    blockedByMe: peerId ? await blockService.hasBlocked(userId, peerId) : false,
                },
            });
        } catch (error) {
            fail(res, error);
        }
    }

    static async createOrGetConversation(req: Request, res: Response): Promise<void> {
        const userId = (req as CustomRequest).userId;
        const { receiverId } = req.body;
        try {
            if (!receiverId) throw new AppError("Receiver ID is required");
            if (!userId) throw new AppError("userId Is required");
            const conversation = await ConversationService.createOrGetConversation(userId, receiverId);
            res.json({ conversationId: conversation._id });
        } catch (error) {
            fail(res, error);
        }
    }

    static async createGroupConversation(req: Request, res: Response): Promise<void> {
        const { groupMembers, groupName, groupDescription } = req.body;
        const groupAdmin = (req as CustomRequest).userId;
        const file = req.file;
        try {
            if (!groupMembers || !groupAdmin) throw new AppError("Members are required Or Group Admin required!");
            const savedConversation = await ConversationService.createGroupConversation(groupAdmin, groupMembers, groupName, groupDescription, file);
            res.status(201).json({ status: true, data: savedConversation, message: 'Group Conversation created Successfully' });
        } catch (error) {
            await discardTempFile(file);
            fail(res, error);
        }
    }

    static async addMembersInGroup(req: Request, res: Response): Promise<void> {
        const currentUserId = (req as CustomRequest).userId!;
        try {
            const { group, added } = await ConversationService.addMembersInGroup(req.params.id, currentUserId, req.body.userIds);
            await membersAdded(group, currentUserId, added);
            res.status(200).json({ status: true, data: group, message: 'Member Added Successfully' });
        } catch (error) {
            fail(res, error);
        }
    }

    static async getUserGroupsConversations(req: Request, res: Response): Promise<void> {
        try {
            const conversations = await ConversationService.getUserGroupsConversations((req as CustomRequest).userId!, archivedFlag(req));
            res.status(200).json({ success: true, data: conversations, message: 'Grop chats get Successfully' });
        } catch (error) {
            fail(res, error);
        }
    }

    static async getGroupInfo(req: Request, res: Response) {
        try {
            const conversation = await ConversationService.getGroupInfo(req.params.id, (req as CustomRequest).userId!);
            res.status(200).json({ status: true, data: conversation, message: 'Data get Successfully' });
        } catch (error) {
            fail(res, error);
        }
    }

    static async deleteConversation(req: Request, res: Response): Promise<void> {
        const { conversationId } = req.params;
        const userId = (req as CustomRequest).userId;
        try {
            if (!conversationId) throw new AppError("Conversation ID is required");
            if (!userId) throw new AppError("User ID is required");
            await ConversationService.deleteConversation(conversationId, userId);
            res.status(200).json({ status: true, data: null, message: 'Conversation deleted successfully' });
        } catch (error) {
            fail(res, error);
        }
    }

    static async removeMemberFromGroup(req: Request, res: Response): Promise<void> {
        const { userId } = req.body;
        const currentUserId = (req as CustomRequest).userId!;
        try {
            const group = await ConversationService.removeMemberFromGroup(req.params.id, currentUserId, userId);
            await memberRemoved(group, currentUserId, String(userId));
            res.status(200).json({ status: true, data: group, message: "Member removed successfully" });
        } catch (error) {
            fail(res, error);
        }
    }

    static async getSharedMedia(req: Request, res: Response): Promise<void> {
        try {
            const media = await MessageService.sharedMedia(req.params.conversationId, (req as CustomRequest).userId!);
            res.status(200).json({ status: true, data: media, message: 'Shared media retrieved successfully' });
        } catch (error) {
            fail(res, error);
        }
    }
}
