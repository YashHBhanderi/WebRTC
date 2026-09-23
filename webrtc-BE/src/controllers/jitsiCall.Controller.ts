import { JwtUtills } from "../utils/jwtUtiils";
import { Request, Response } from "express";

export default class JitsiCallController {
    static async generateJitsiToken(req: Request, res: Response): Promise<void> {
        const { roomName } = req.params;
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) {
            res.status(401).json({ status: false, message: "Unauthorized" });
        }
        try {
            if (!roomName) throw new Error("Room name is required");
            const decoded: any = JwtUtills.verifyToken(token!);
            const jitsiToken = await JwtUtills.generateJitsiToken(decoded.userId, req.params.roomName);
            res.status(200).json({
                status: true,
                allowed: true,
                jwt: jitsiToken,
                roomName: req.params.roomName
            });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }
}