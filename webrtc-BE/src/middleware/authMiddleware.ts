import { NextFunction, Request, Response } from "express";
import { JwtUtills } from "../utils/jwtUtiils";
import CustomRequest from "../types/customRequest";


async function verifyToken(req: Request, res: Response, next: NextFunction): Promise<void> {

    const token = req.header('Authorization')?.split(' ')[1];
    if (!token) {
        res.status(401).json({ success: false, message: "Authentication token not found. Please log in to continue!" });
        return;
    }
    try {
        const decoded = JwtUtills.verifyToken(token!) as { userId: string };
        (req as CustomRequest).userId = decoded.userId;
        next();
    } catch (error) {
        // 401 tells the client to end the session and show the login page
        res.status(401).json({ success: false, message: "Session expired. Please log in again." });
    }
}

export default verifyToken;