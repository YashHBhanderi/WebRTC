import mongoose from "mongoose";
import Message from "../../models/messageModel";
import Conversation from "../../models/conversationModel";
import User, { IUser } from "../../models/userModel";
import ConversationService from "../../services/conversationService";
import blockService from "../../services/block.service";
import { directPeerId, isMember } from "../../services/authorization.service";
import { attachMessageFile, messageMedia } from "../../services/file.service";
import { IStoredFile } from "../../models/storedFile.schema";
import notificationService from "../../services/notification.service";
import receiptsService from "../../services/receipts.service";
import messageActions, { MAX_MESSAGE_LENGTH, validateMessageText, validMentions } from "../../services/message-actions.service";
import { broadcastMessage } from "../../services/call-session.service";
import { PUBLIC_USER_FIELDS } from "../../utils/validation";
import { publicMessage } from "../../utils/errors";
import { AuthedSocket, emitToUsers, io } from "../io";

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
    /** User ids @mentioned in the text (must be members). */
    mentions?: string[];
}

type Ack = ((response: { success?: boolean; error?: string; [key: string]: unknown }) => void) | undefined;

/** Types a client may send ("system" is server-only). */
const CLIENT_MESSAGE_TYPES = new Set(["text", "image", "video", "audio", "pdf", "file", "call"]);
const MEDIA_TYPES = new Set(["image", "video", "audio", "pdf", "file"]);

interface MessageBody {
    type: string;
    content: string;
    file?: IStoredFile | null;
    fileUrl: string;
    thumbnailUrl: string;
    forwardedFrom?: string;
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
        const origin = await Conversation.findOne({ _id: source.conversationId, members: userId }).select("isGroup groupName").lean();
        if (!origin) {
            return null;
        }
        // A forward of a forward keeps naming where it first came from
        const forwardedFrom = source.forwardedFrom
            || (origin.isGroup ? origin.groupName : (await User.findById(source.userId).select("username").lean())?.username)
            || "";
        return {
            type: source.type,
            content: source.content,
            file: source.file || undefined,
            fileUrl: source.fileUrl || "",
            thumbnailUrl: source.thumbnailUrl || "",
            forwardedFrom: forwardedFrom.slice(0, 120),
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

            if (body.type === "text") {
                try {
                    body.content = validateMessageText(body.content);
                } catch (error) {
                    socket.emit("message:rejected", { conversationId: String(conversation._id), reason: "invalid", message: publicMessage(error, "Message not sent") });
                    return;
                }
            } else if (body.content.length > MAX_MESSAGE_LENGTH) {
                body.content = body.content.slice(0, MAX_MESSAGE_LENGTH);
            }

            // A reply may only quote a visible message of this same chat
            const replyTo = messageData.replyTo && mongoose.isValidObjectId(messageData.replyTo)
                ? await Message.exists({ _id: messageData.replyTo, conversationId: conversation._id, isDeleted: { $ne: true } })
                : null;
            const memberIds = conversation.members.map(String);
            const mentions = messageData.forwardOf ? [] : validMentions(messageData.mentions, memberIds, me());

            const newMessage = new Message({
                userId: me(),
                conversationId: conversation._id,
                content: body.content,
                file: body.file,
                fileUrl: body.fileUrl,
                thumbnailUrl: body.thumbnailUrl,
                type: body.type,
                forwardedFrom: body.forwardedFrom || undefined,
                replyTo: replyTo ? replyTo._id : null,
                mentions: mentions.length ? mentions : undefined,
                createdAt: new Date(),
            });
            await newMessage.save();

            const populatedMessage = await Message.findById(newMessage._id).populate({ path: "replyTo", select: "content type userId" });
            const conversationId = String(conversation._id);
            // Author details from the database — never the name/avatar the client sent
            const author = await User.findById(me()).select(PUBLIC_USER_FIELDS).lean();
            // Pre-signed links instead of storage keys
            const payload = {
                ...(populatedMessage ? { ...populatedMessage.toObject(), ...(await messageMedia(populatedMessage)), file: undefined } : {}),
                user: author,
                conversationId,
                status: "sent",
            };
            broadcastMessage(conversationId, conversation.members, payload);

            // Mentions and replies → Activity (a mentioned author of the quoted message gets one entry)
            const preview = body.type === "text" ? body.content : `Sent ${body.type === "pdf" ? "a document" : `a ${body.type}`}`;
            const mentioned = new Set(mentions.map(String));
            const quoted = populatedMessage?.replyTo as any;
            void notificationService.notify([
                ...[...mentioned].map((userId) => ({
                    userId,
                    type: "mention" as const,
                    actorId: me(),
                    conversationId,
                    messageId: String(newMessage._id),
                    text: preview,
                })),
                ...(quoted?.userId && String(quoted.userId) !== me() && !mentioned.has(String(quoted.userId))
                    ? [{ userId: String(quoted.userId), type: "reply" as const, actorId: me(), conversationId, messageId: String(newMessage._id), text: preview }]
                    : []),
            ]);
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
            const allowed = mongoose.isValidObjectId(data.messageId) && mongoose.isValidObjectId(data.conversationId)
                && await Conversation.exists({ _id: data.conversationId, members: me() })
                && await Message.exists({ _id: data.messageId, conversationId: data.conversationId, isDeleted: { $ne: true } });
            if (!allowed) {
                return;
            }
            const updatedMessage = await ConversationService.addReaction(data.messageId, me(), data.emoji);
            io().to(data.conversationId).emit("messageReactionUpdated", {
                messageId: data.messageId,
                reactions: updatedMessage.reactions,
                conversationId: data.conversationId,
            });

            // Reaction added (not removed) to someone else's message → their Activity
            const added = (updatedMessage.reactions || []).some((r: any) => String(r.userId) === me() && r.emoji === data.emoji);
            const authorId = String((updatedMessage as any).userId?._id || (updatedMessage as any).userId || "");
            if (added && authorId && authorId !== me()) {
                void notificationService.notify({
                    userId: authorId,
                    type: "reaction",
                    actorId: me(),
                    conversationId: data.conversationId,
                    messageId: data.messageId,
                    text: data.emoji,
                });
            }
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
            await receiptsService.markRead(me(), id);
            // Older clients flip ticks on this event
            io().to(id).emit("messagesMarkedRead", { conversationId: id, userId: me() });
            void notificationService.markConversationRead(me(), id);
        } catch (error) {
            console.error("Error marking messages as read:", error);
        }
    });

    // A message reached this device (sent once per chat, batched by the client)
    socket.on("message:delivered", async (data: { conversationIds?: unknown }) => {
        try {
            const ids = Array.isArray(data?.conversationIds) ? data.conversationIds.map(String).slice(0, 50) : [];
            const mine = await Conversation.find({ _id: { $in: ids.filter((id) => mongoose.isValidObjectId(id)) }, members: me() }).select("_id").lean();
            await receiptsService.markDelivered(me(), mine.map((c) => String(c._id)));
        } catch (error) {
            console.error("Error marking messages delivered:", error);
        }
    });

    socket.on("message:edit", async (data: { messageId?: string; content?: string; mentions?: string[] }, ack: Ack) => {
        try {
            const { message, conversation, addedMentions } = await messageActions.edit(data?.messageId, me(), data?.content, data?.mentions);
            const conversationId = String(conversation._id);
            emitToUsers(conversation.members, "message:updated", {
                conversationId,
                messageId: String(message._id),
                content: message.content,
                editedAt: message.editedAt,
                mentions: (message.mentions || []).map(String),
            });
            void notificationService.notify(addedMentions.map((userId) => ({
                userId,
                type: "mention" as const,
                actorId: me(),
                conversationId,
                messageId: String(message._id),
                text: message.content,
            })));
            ack?.({ success: true });
        } catch (error) {
            ack?.({ error: publicMessage(error, "We couldn't edit the message. Please try again.") });
        }
    });

    socket.on("message:pin", async (data: { messageId?: string; pinned?: boolean }, ack: Ack) => {
        try {
            const result = await messageActions.setPinned(data?.messageId, me(), data?.pinned !== false);
            emitToUsers(result.members, "message:pins", { conversationId: result.conversationId, pins: result.pins });
            ack?.({ success: true, pins: result.pins });
        } catch (error) {
            ack?.({ error: publicMessage(error, "We couldn't update the pin. Please try again.") });
        }
    });
}
