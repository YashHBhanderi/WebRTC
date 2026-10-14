import * as dotenv from "dotenv";

dotenv.config();

/**
 * Sign-in is handled by Clerk (clerk.com). Keys come from the environment; the secret key never
 * leaves the server, the publishable key is public and is handed to the browser via GET /config.
 *
 *   CLERK_PUBLISHABLE_KEY      required, pk_test_… / pk_live_…
 *   CLERK_SECRET_KEY           required, sk_test_… / sk_live_…
 *   CLERK_AUTHORIZED_PARTIES   recommended in production: comma-separated origins allowed to use
 *                              session tokens, e.g. https://chat.example.com (blocks tokens minted
 *                              for other sites/subdomains)
 *   CLERK_JWT_KEY              optional PEM public key for networkless token verification
 *   CLERK_CLOCK_SKEW_MS        optional clock tolerance for session tokens (see below)
 *
 * Session tokens (~60 s lifetime) are checked against this server's clock. Development keys
 * (pk_test_) tolerate up to 3 min of clock drift so a PC with a slightly wrong clock can still sign
 * in; production keys (pk_live_) use Clerk's default 5 s. Keep server clocks synced (NTP).
 */
const DEV_CLOCK_SKEW_MS = 3 * 60_000;
const LIVE_CLOCK_SKEW_MS = 5_000;
const list = (value: string | undefined): string[] =>
    (value || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

export const authConfig = {
    publishableKey: (process.env.CLERK_PUBLISHABLE_KEY || "").trim(),
    secretKey: (process.env.CLERK_SECRET_KEY || "").trim(),
    jwtKey: (process.env.CLERK_JWT_KEY || "").trim() || undefined,
    authorizedParties: list(process.env.CLERK_AUTHORIZED_PARTIES),
    clockSkewMs: clockSkew(),
};

function clockSkew(): number {
    const explicit = Number(process.env.CLERK_CLOCK_SKEW_MS);
    if (process.env.CLERK_CLOCK_SKEW_MS && Number.isFinite(explicit) && explicit >= 0) {
        return explicit;
    }
    return (process.env.CLERK_PUBLISHABLE_KEY || "").trim().startsWith("pk_test_") ? DEV_CLOCK_SKEW_MS : LIVE_CLOCK_SKEW_MS;
}

export const isAuthConfigured = (): boolean => !!(authConfig.publishableKey && authConfig.secretKey);

if (!isAuthConfigured()) {
    // Names only — never log key values
    const missing = [
        ["CLERK_PUBLISHABLE_KEY", authConfig.publishableKey],
        ["CLERK_SECRET_KEY", authConfig.secretKey],
    ].filter(([, v]) => !v).map(([name]) => name);
    console.warn(`[auth] ${missing.join(", ")} not set — sign-in is disabled until they are configured`);
} else if (!authConfig.authorizedParties.length && process.env.NODE_ENV === "production") {
    console.warn("[auth] CLERK_AUTHORIZED_PARTIES not set — set it to your app's origin(s) in production");
}
