import mongoose from "mongoose";
import Block from "../models/blockModel";
import User from "../models/userModel";
import { AppError, NotFoundError } from "../utils/errors";
import { requireObjectId } from "../utils/validation";

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/**
 * Contact blocking. The blocker is always the authenticated user (never taken from the payload),
 * so nobody can create or remove someone else's block.
 */
class BlockService {
    async block(blockerId: string, target: unknown): Promise<void> {
        const targetId = requireObjectId(target, "userId");
        if (targetId === String(blockerId)) {
            throw new AppError("You cannot block yourself");
        }
        if (!(await User.exists({ _id: targetId }))) {
            throw new NotFoundError("User not found");
        }
        await Block.updateOne(
            { blockerId: oid(blockerId), blockedUserId: oid(targetId) },
            { $setOnInsert: { blockerId: oid(blockerId), blockedUserId: oid(targetId) } },
            { upsert: true }
        );
    }

    async unblock(blockerId: string, target: unknown): Promise<void> {
        const targetId = requireObjectId(target, "userId");
        await Block.deleteOne({ blockerId: oid(blockerId), blockedUserId: oid(targetId) });
    }

    async hasBlocked(blockerId: string, targetId: string): Promise<boolean> {
        return !!(await Block.exists({ blockerId: oid(blockerId), blockedUserId: oid(targetId) }));
    }

    /** Either side blocked the other → no messages or calls between them. */
    async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
        return !!(await Block.exists({
            $or: [
                { blockerId: oid(a), blockedUserId: oid(b) },
                { blockerId: oid(b), blockedUserId: oid(a) },
            ],
        }));
    }
}

export default new BlockService();
