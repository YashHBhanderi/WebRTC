import Message from "../models/messageModel";

export default class MessageService{
 public static async deleteMessageById(messageId: string, userId: string) {
    const message = await Message.findById(messageId);

    if (!message) {
        throw new Error("Message not found");
    }

    if (message.userId.toString() !== userId) {
        throw new Error("Unauthorized to delete this message");
    }
    message.isDeleted = true;
    await message.save();
    return { success: true, message: "Message deleted successfully" };
 }
}
