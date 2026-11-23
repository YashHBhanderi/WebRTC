// Example backend for backendTokenProvider(). It holds the app credential (never send it to a
// browser) and exchanges it for a short-lived token for the signed-in user.
//
// EXAMPLE ONLY: it maps every request to SPREEWE_DEMO_USER_ID. A real backend MUST authenticate its
// own user first (session cookie, JWT ...) and use that user's SpreeWe id or externalUserRef.
//
//   SPREEWE_API_URL=http://localhost:8080 SPREEWE_KEY_ID=swk_test_... SPREEWE_SECRET=sws_... \
//   SPREEWE_DEMO_USER_ID=<24-hex user id> ALLOWED_ORIGIN=http://localhost:5173 node server.mjs
import http from "node:http";

const { SPREEWE_API_URL, SPREEWE_KEY_ID, SPREEWE_SECRET, SPREEWE_DEMO_USER_ID, ALLOWED_ORIGIN = "http://localhost:5173", PORT = "8787" } = process.env;
for (const [k, v] of Object.entries({ SPREEWE_API_URL, SPREEWE_KEY_ID, SPREEWE_SECRET, SPREEWE_DEMO_USER_ID })) {
    if (!v) throw new Error(`${k} is required`);
}
const basic = `Basic ${Buffer.from(`${SPREEWE_KEY_ID}:${SPREEWE_SECRET}`).toString("base64")}`;

http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "POST" || req.url !== "/spreewe-token") return res.writeHead(404).end();
    // 1. Authenticate YOUR user here (omitted in this example).
    // 2. Exchange the credential for a token for that user (60-900 s, default 600 s).
    try {
        const upstream = await fetch(`${SPREEWE_API_URL}/v1/app-tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: basic },
            body: JSON.stringify({ userId: SPREEWE_DEMO_USER_ID }),
        });
        const body = await upstream.json().catch(() => ({}));
        if (upstream.status !== 201) {
            res.writeHead(upstream.status === 403 ? 403 : 502, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: body?.error?.message || "Token exchange failed" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accessToken: body.data.accessToken, expiresAt: body.data.expiresAt }));
    } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "SpreeWe is unreachable" }));
    }
}).listen(Number(PORT), () => console.log(`token server on http://localhost:${PORT}/spreewe-token`));
