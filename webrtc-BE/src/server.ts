import * as dotenv from "dotenv";
dotenv.config();
// Before anything logs: redact tokens, secrets, query strings, emails and DB-echoed values
import { installSafeConsole } from "./utils/safe-log";
installSafeConsole();

import http from "http";
import dns from "dns";
import connectDB from "./config/database";
import mediasoupService from "./services/mediasoup.service";
import { mediaConfig } from "./utils/network";
import { createApp } from "./app";
import { installShutdownHandlers } from "./shutdown";
import { stopSocketRevalidation } from "./realtime/revalidate";
import { startWebhookWorker, stopWebhookWorker } from "./webhooks/worker";
import { installAppRoomShadows, io } from "./realtime/io";
import { setUpCluster, stopCluster } from "./realtime/cluster";
import { markShuttingDown } from "./health";
import { startClockMonitor, stopClockMonitor } from "./config/clock";
import { assertProductionSecrets, resolveCorsOrigins } from "./config/security";
import { startRealtime } from "./realtime";
import { runMigrations } from "./migrations";
import { runAsSystem } from "./tenancy/context";
import meetingService from "./services/meeting.service";
import recordingService from "./services/recording.service";

/**
 * Bootstrap only: config → HTTP app → Socket.IO gateways → DB (+ migrations) → mediasoup → listen.
 * REST lives in ./app + ./routes, socket handlers in ./realtime/gateways, logic in ./services.
 */
dns.setDefaultResultOrder("ipv4first");

const port = process.env.PORT ?? 8080;

// Comma-separated allow-list, e.g. CORS_ORIGINS=https://app.example.com. Unset = allow all (dev only);
// production refuses to start without it (see config/security.ts)
const corsOrigin = resolveCorsOrigins();
assertProductionSecrets();

const app = createApp(corsOrigin);
const server = http.createServer(app);
startRealtime(server, corsOrigin);
installShutdownHandlers({
  server,
  io,
  stopTimers: () => {
    markShuttingDown();
    stopClockMonitor();
    recordingService.stopTempCleanup();
    void stopCluster();
    meetingService.stopReminders();
    stopSocketRevalidation();
    stopWebhookWorker();
  },
  closeMedia: () => mediasoupService.close(),
});

connectDB()
  .then(async () => {
    // Additive + idempotent; set RUN_MIGRATIONS=false to run them separately (npm run migrate)
    if (process.env.RUN_MIGRATIONS !== "false") {
      await runAsSystem(() => runMigrations(), "migrations");
    }
    // Shared Socket.IO events between instances (SOCKET_ADAPTER=mongo) + instance heartbeat
    await setUpCluster(io());
    // The cluster adapter is a new adapter instance: re-attach developer-app room shadows to it
    installAppRoomShadows(io());
    await mediasoupService.init();
    // Meeting reminders (5 minutes before each occurrence)
    meetingService.startReminders();
    startWebhookWorker();
    // Host clock vs the token issuer (NTP is a deployment prerequisite; this only reports)
    startClockMonitor();
    await runAsSystem(() => recordingService.recoverOnStartup(), "startup-recovery");
    // Temp folders of finished / failed recordings, after RECORDING_TMP_RETENTION_HOURS (never active ones)
    recordingService.startTempCleanup();
    server.listen(Number(port), "0.0.0.0", () => {
      console.log(`Server is running on port ${port}`);
    });
  })
  .catch((error) => {
    console.log("Error starting server:", error.message);
  });
