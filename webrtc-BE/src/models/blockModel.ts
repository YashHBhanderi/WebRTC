import mongoose, { Schema, Document } from "mongoose";

/** blockerId has blocked blockedUserId (contact-level, independent of any chat). */
export interface IBlock extends Document {
    blockerId: mongoose.Types.ObjectId;
    blockedUserId: mongoose.Types.ObjectId;
    createdAt: Date;
}

const BlockSchema = new Schema<IBlock>(
    {
        blockerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        blockedUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

// Unique pair; equality on both fields also answers the reverse-direction check
BlockSchema.index({ blockerId: 1, blockedUserId: 1 }, { unique: true });

const Block = mongoose.model<IBlock>("Block", BlockSchema, "blocks");
export default Block;
