import mongoose from "mongoose";
import Message from "../../models/messageModel";
import Conversation from "../../models/conversationModel";
import { IUser } from "../../models/userModel";
import ConversationService from "../../services/conversationService";
import blockService from "../../services/block.service";
import { directPeerId, isMember } from "../../services/authorization.service";
import { attachMessageFile, messageMedia } from "../../services/file.service";
import { IStoredFile } from "../../models/storedFile.schema";
import { publicMessage } from "../../utils/errors";
import { AuthedSocket, io, userSockets } from "../io";

interface SendMessagePayload {
    user: IUser;
    conversationId: string;
    content: string;
    /** "call" messages only: the join link. Media URLs from clients are ignored. */
    fileUrl?: string;
    type: string;
    replyTo?: string;
    /** Media: key returned by POST /upload for this conversation. */
    storageKey?: string;
    /** Forward: id of the message to copy (content + attachment) into this conversation. */
    forwardOf?: string;
}

/** Types a client may send ("system" is server-only). */
const CLIENT_MESSAGE_TYPES = new Set(["text", "image", "video", "audio", "pdf", "call"]);
const MEDIA_TYPES = new Set(["image", "video", "audio", "pdf"]);

interface MessageBody {
    type: string;
    content: string;
    file?: IStoredFile | null;
    fileUrl: string;
    thumbnailUrl: string;
}

/**
 * What gets stored for a send. Attachments must be files this user uploaded into this
 * conversation's folder; forwards are copied server-side from a message the user can see.
 */
async function resolveBody(data: SendMessagePayload, conversationId: string, userId: string): Promise<MessageBody | null> {
    if (data.forwardOf) {
        if (!mongoose.isValidObjectId(data.forwardOf)) {
            return null;
        }
        const source = await Message.findOne({ _id: data.forwardOf, isDeleted: { $ne: true } }).lean();
        if (!source || source.type === "system" || !source.conversationId) {
            return null;
        }
        const canSee = await Conversation.exists({ _id: source.conversationId, members: userId });
        if (!canSee) {
            return null;
        }
        return {
            type: source.type,
            content: source.content,
            file: source.file || undefined,
            fileUrl: source.fileUrl || "",
            thumbnailUrl: source.thumbnailUrl || "",
        };
    }
    const content = typeof data.content === "string" ? data.content : "";
    if (MEDIA_TYPES.has(data.type)) {
        const { file, type } = await attachMessageFile(data.storageKey, conversationId, userId);
        return { type, content: content || type, file, fileUrl: "", thumbnailUrl: "" };
    }
    const link = data.type === "call" && typeof data.fileUrl === "string" ? data.fileUrl.slice(0, 2048) : "";
    return { type: data.type, content: content || data.type, fileUrl: link, thumbnailUrl: link };
}

/** Messages: send (also used for forwarding), reactions, read receipts. Event names unchanged. */
export function registerMessageGateway(socket: AuthedSocket): void {
    const me = () => String(socket.data.userId);

    socket.on("sendMessage", async (messageData: SendMessagePayload) => {
        try {
            // Sender must be the authenticated socket user and a member of the conversation
            if (!messageData?.conversationId || String(messageData.user?._id) !== me()) {
                console.warn(`sendMessage rejected: sender mismatch for socket user ${me()}`);
                return;
            }
            if (!CLIENT_MESSAGE_TYPES.has(messageData.type)) {
                return;
            }

            const conversation = await Conversation.findById(messageData.conversationId).select("members isGroup");
            if (!conversation) {
                console.log("Conversation not found");
                return;
            }
            if (!isMember(conversation, me())) {
                console.warn(`sendMessage rejected: ${me()} is not a member of ${messageData.conversationId}`);
                return;
            }
            // Blocked either way → nothing is delivered (1:1 only)
            const peerId = directPeerId(conversation, me());
            if (peerId && (await blockService.isBlockedEitherWay(me(), peerId))) {
                socket.emit("message:rejected", { conversationId: String(conversation._id), reason: "blocked" });
                return;
            }

            let body: MessageBody | null;
            try {
                body = await resolveBody(messageData, String(conversation._id), me());
            } catch (error) {
                socket.emit("message:rejected", { conversationId: String(conversation._id), reason: "attachment", message: publicMessage(error, "Could not attach the file") });
                return;
            }
            if (!body) {
                socket.emit("message:rejected", { conversationId: String(conversation._id), reason: "forward", message: "This message can't be forwarded" });
                return;
            }

            const newMessage = new Message({
                userId: messageData.user._id,
                conversationId: conversation._id,
                content: body.content,
                file: body.file,
                fileUrl: body.fileUrl,
                thumbnailUrl: body.thumbnailUrl,
                type: body.type,
                replyTo: messageData.replyTo && mongoose.isValidObjectId(messageData.replyTo)
                    ? new mongoose.Types.ObjectId(messageData.replyTo)
                    : null,
                createdAt: new Date(),
            });
            await newMessage.save();
            await Conversation.updateOne({ _id: conversation._id }, { $push: { messages: newMessage._id } });

            const populatedMessage = await Message.findById(newMessage._id).populate("replyTo");
            const conversationId = String(conversation._id);
            // Signed links instead of storage keys
            const stored = populatedMessage ? { ...populatedMessage.toObject(), ...messageMedia(populatedMessage), file: undefined } : {};

            io().to(conversationId).emit("receiveMessage", {
                ...stored,
                user: messageData.user,
                conversationId: messageData.conversationId,
            });

            conversation.members.forEach((member) => {
                const memberId = member.toString();
                if (userSockets.has(memberId) && memberId !== me()) {
                    io().to(userSockets.get(memberId)!).emit("receiveMessage", {
                        ...stored,
                        conversationId: messageData.conversationId,
                    });
                }
            });
        } catch (error) {
            console.error("Error sending message:", error);
        }
    });

    socket.on("reactToMessage", async (data: { messageId: string; emoji: string; conversationId: string }) => {
        try {
            if (!data?.messageId || !data.conversationId || typeof data.emoji !== "string" || data.emoji.length > 16) {
                return;
            }
            // Only members may react, and only to messages of that conversation
            const allowed = await Conversation.exists({ _id: data.conversationId, members: me(), messages: data.messageId });
            if (!allowed) {
                return;
            }
            const updatedMessage = await ConversationService.addReaction(data.messageId, me(), data.emoji);
            io().to(data.conversationId).emit("messageReactionUpdated", {
                messageId: data.messageId,
                reactions: updatedMessage.reactions,
                conversationId: data.conversationId,
            });
        } catch (error) {
            console.error("Error adding reaction:", error);
        }
    });

    // The reader is always the socket's user (the second argument from old clients is ignored)
    socket.on("markMessagesRead", async (conversationId: unknown) => {
        try {
            const id = String(conversationId || "");
            const conversation = await Conversation.findById(id).select("members");
            if (!conversation || !isMember(conversation, me())) {
                return;
            }
            await Message.updateMany(
                { conversationId: conversation._id, isRead: false, userId: { $ne: new mongoose.Types.ObjectId(me()) } },
                { $set: { isRead: true } }
            );
            io().to(id).emit("messagesMarkedRead", { conversationId: id, userId: me() });
        } catch (error) {
            console.error("Error marking messages as read:", error);
        }
    });
}
