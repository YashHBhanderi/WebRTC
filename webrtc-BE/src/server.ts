import * as dotenv from "dotenv";
dotenv.config();

import http from "http";
import dns from "dns";
import connectDB from "./config/database";
import mediasoupService from "./services/mediasoup.service";
import { mediaConfig } from "./utils/network";
import { createApp } from "./app";
import { startRealtime } from "./realtime";
import { runMigrations } from "./migrations";

/**
 * Bootstrap only: config → HTTP app → Socket.IO gateways → DB (+ migrations) → mediasoup → listen.
 * REST lives in ./app + ./routes, socket handlers in ./realtime/gateways, logic in ./services.
 */
dns.setDefaultResultOrder("ipv4first");

const port = process.env.PORT ?? 8080;

// Comma-separated allow-list, e.g. CORS_ORIGINS=https://app.example.com. Unset = allow all (dev).
const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const corsOrigin: string[] | "*" = corsOrigins.length ? corsOrigins : "*";
if (mediaConfig.isProduction && corsOrigin === "*") {
  console.warn("CORS_ORIGINS is not set — API and socket accept any origin");
}

const app = createApp(corsOrigin);
const server = http.createServer(app);
startRealtime(server, corsOrigin);

connectDB()
  .then(async () => {
    // Additive + idempotent; set RUN_MIGRATIONS=false to run them separately (npm run migrate)
    if (process.env.RUN_MIGRATIONS !== "false") {
      await runMigrations();
    }
    await mediasoupService.init();
    server.listen(Number(port), "0.0.0.0", () => {
      console.log(`Server is running on port ${port}`);
    });
  })
  .catch((error) => {
    console.log("Error starting server:", error.message);
  });
