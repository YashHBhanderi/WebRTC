import express from "express";
import path from "path";
import cors from "cors";
import router from "./routes/routes";
import { uploadSingle } from "./utils/multer";
import verifyToken from "./middleware/authMiddleware";
import uploadFile from "./controllers/upload.controller";
import { logger } from "./utils/logger";
import { storageConfig } from "./config/storage";

/** Express app: middleware + REST routes. Socket.IO lives in ./realtime. */
export function createApp(corsOrigin: string[] | "*") {
    const app = express();

    app.use(logger);
    app.use(express.json({ limit: "1000mb" }));
    app.use(express.urlencoded({ extended: true, limit: "1000mb" }));
    app.use(cors({ origin: corsOrigin }));

    const api = express.Router();
    api.use(router);
    // Stored files (S3): upload needs a session; clients read straight from S3 (see file.service)
    api.post("/upload", verifyToken, uploadSingle("file"), uploadFile);
    // Public client settings (no secrets): where to load public objects (profile/group pictures) from
    api.get("/config", (_req, res) => {
        res.json({ status: true, data: { s3BaseUrl: storageConfig.publicBaseUrl }, message: "" });
    });

    // Every endpoint answers with and without the /api prefix, so it works whether the reverse
    // proxy strips the prefix (dev proxy.conf.js) or forwards /api/* unchanged (nginx on the server)
    app.use("/api", api);
    app.use("/", api);
    app.use("/uploads", express.static(path.join(__dirname, "/uploads")));

    return app;
}
