import { Request, Response } from "express";
import mongoose from "mongoose";
import userServices, { parseProfileUpdate, validateUsername } from "../services/userServices";
import CustomRequest from "../types/customRequest";
import { IStoredFile } from "../models/storedFile.schema";
import { releaseFile, storeUpload } from "../services/file.service";
import { discardTempFile } from "../utils/multer";
import { AppError, sendError } from "../utils/errors";
import { io } from "../realtime/io";
import presenceService, { publicStatus } from "../services/presence.service";

function fail(res: Response, error: unknown, fallback: string): void {
    sendError(res, error, fallback);
}

export default class UserController {
    /** The signed-in user's app account (linked/created from the Clerk session by verifyToken). */
    static async me(req: Request, res: Response): Promise<void> {
        try {
            const user = await userServices.getUserById(String((req as CustomRequest).userId));
            if (!user) throw new AppError('Account not found', 404);
            // My own chosen status, unmasked
            res.status(200).json({ status: true, data: { ...user.toJSON(), status: user.status }, message: '' });
        } catch (error) {
            fail(res, error, 'Could not load your account');
        }
    }

    static async getAllUser(req: Request, res: Response): Promise<void> {
        try {
            const allUser = await userServices.allUser();
            if (!allUser) {
                throw new Error('Users Not Found!');
            }
            res.status(200).json({ status: true, data: allUser, message: 'All Users' });
        } catch (error) {
            sendError(res, error);
        }
    }
    static async deleteUser(req: Request, res: Response): Promise<void> {
        try {
            const userId = req.params.id;
            // There are no admin roles: a user may only delete their own account
            if (String((req as CustomRequest).userId) !== String(userId)) {
                res.status(403).json({ status: false, data: null, message: 'You can only delete your own account' });
                return;
            }
            await userServices.deleteUser(userId)
            res.status(200).json({ status: true, data: null, message: 'User Deleted Successfully' });

        } catch (error) {
            sendError(res, error);
        }
    }


    static async getUserById(req: Request, res: Response): Promise<void> {
        try {
            const userId = req.params.userId;
            if (!userId) throw new Error('User Id is required')
            const user = await userServices.getUserById(userId);
            if (!user) throw new Error('User Not Found!');
            res.status(200).json({ status: true, data: user, message: 'User get Successfully' });

        } catch (error) {
            sendError(res, error);
        }
    }

    static async getAllUsersExceptCurrentUser(req: Request, res: Response): Promise<void> {
        try {
            const userId = (req as CustomRequest).userId;
            if (!userId) throw new Error('User Id is required')
            const user = await userServices.getAllUsersExceptCurrentUser(userId);
            if (!user) throw new Error('Users Not Found!');
            res.status(200).json({ status: true, data: user, message: 'User get Successfully' });

        } catch (error) {
            sendError(res, error);
        }
    }

    /**
     * PATCH /web/user/profile (multipart): username?, bio?, image? — for the signed-in user only.
     * The user id comes from the token; email cannot be changed here.
     */
    static async updateProfile(req: Request, res: Response): Promise<void> {
        let uploaded: IStoredFile | undefined;
        try {
            const userId = String((req as CustomRequest).userId || '');
            if (!userId) throw new AppError('Not signed in', 401);
            // Validate text first: a rejected name must not leave an uploaded picture behind
            const update = parseProfileUpdate(req.body);
            if (req.file) {
                uploaded = (await storeUpload(req.file, { purpose: "avatar", userId }, userId)).stored;
            }
            const user = await userServices.updateProfile(userId, update, uploaded);
            // Everyone's chat lists / headers pick up the new name and picture live
            io().emit("user:updated", { _id: userId, username: user.username, avatar: user.avatar, bio: user.bio, status: publicStatus(user.status) });
            void presenceService.publish(String(userId)).catch(() => undefined);
            res.status(200).json({ status: true, data: user, message: 'Profile updated successfully' });
        } catch (error) {
            await discardTempFile(req.file);
            await releaseFile(uploaded);
            fail(res, error, 'Could not update the profile');
        }
    }

}
