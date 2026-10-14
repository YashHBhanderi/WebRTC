import mongoose, { Schema, Document } from "mongoose";

/** A message one user saved ("starred") for later. Private to that user. */
export interface ISavedMessage extends Document {
    userId: mongoose.Types.ObjectId;
    messageId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    createdAt: Date;
}

const SavedMessageSchema = new Schema<ISavedMessage>({
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    messageId: { type: Schema.Types.ObjectId, ref: "Message", required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    createdAt: { type: Date, default: Date.now },
});

// Save once per user; "my saved messages" newest first
SavedMessageSchema.index({ userId: 1, messageId: 1 }, { unique: true });
SavedMessageSchema.index({ userId: 1, createdAt: -1 });

const SavedMessage = mongoose.model<ISavedMessage>("SavedMessage", SavedMessageSchema, "saved_messages");
export default SavedMessage;
