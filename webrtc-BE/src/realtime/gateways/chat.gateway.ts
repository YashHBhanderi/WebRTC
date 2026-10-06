import Conversation from "../../models/conversationModel";
import chatState from "../../services/chat-state.service";
import blockService from "../../services/block.service";
import { getConversationForMember } from "../../services/authorization.service";
import { AuthedSocket, onAck } from "../io";

/**
 * chat:* — per-user chat state (archive, clear), contact blocking, rooms and typing.
 * Archive/clear/block only ever change the authenticated user's own data.
 */
export function registerChatGateway(socket: AuthedSocket): void {
    const me = () => String(socket.data.userId);

    // Room membership is verified, so room broadcasts only reach real members
    socket.on("joinConversation", async (conversationId: unknown) => {
        try {
            const id = String(conversationId || "");
            if (!(await Conversation.exists({ _id: id, members: me() }))) {
                return;
            }
            socket.join(id);
        } catch {
            // invalid id → ignore
        }
    });

    // Typing only to rooms this socket was allowed to join; the sender id is the socket's user
    const typing = (isTyping: boolean) => (conversationId: unknown) => {
        const room = String(conversationId || "");
        if (!room || !socket.rooms.has(room)) {
            return;
        }
        socket.broadcast.to(room).emit("userTyping", { userId: me(), isTyping, conversationId: room });
    };
    socket.on("typing", typing(true));
    socket.on("stopTyping", typing(false));

    onAck(socket, "chat:archive", async ({ conversationId }) => {
        const conversation = await getConversationForMember(conversationId, me());
        return { conversationId: String(conversation._id), state: await chatState.setArchived(me(), String(conversation._id), true) };
    });

    onAck(socket, "chat:unarchive", async ({ conversationId }) => {
        const conversation = await getConversationForMember(conversationId, me());
        return { conversationId: String(conversation._id), state: await chatState.setArchived(me(), String(conversation._id), false) };
    });

    onAck(socket, "chat:clear", async ({ conversationId }) => {
        const conversation = await getConversationForMember(conversationId, me());
        return { conversationId: String(conversation._id), state: await chatState.clear(me(), String(conversation._id)) };
    });

    onAck(socket, "chat:block", async ({ userId }) => {
        await blockService.block(me(), userId);
        return { userId: String(userId), blocked: true };
    });

    onAck(socket, "chat:unblock", async ({ userId }) => {
        await blockService.unblock(me(), userId);
        return { userId: String(userId), blocked: false };
    });
}
