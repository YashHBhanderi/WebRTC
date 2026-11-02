/**
 * Minimal Express backend showing the token hand-off. YOUR authentication stays yours: this route
 * first checks your own session, then maps your user to the externalUserRef they used when they
 * authorised your SpreeWe app, and returns a short-lived SpreeWe token to your frontend.
 *
 *   SPREEWE_API=https://api.example.com/api SPREEWE_KEY_ID=swk_… SPREEWE_SECRET=sws_… ts-node server.ts
 */
import express from "express";
import { SpreeWeApiError, SpreeWeServerClient } from "./spreewe-server-client";

const spreewe = new SpreeWeServerClient(process.env.SPREEWE_API!, process.env.SPREEWE_KEY_ID!, process.env.SPREEWE_SECRET!);
const app = express();
app.use(express.json());

/** Replace with your real session check (cookie, JWT…). Never trust a user id sent by the browser. */
function currentUser(req: express.Request): { id: string } | null {
    return (req as any).user ?? null;
}

app.post("/spreewe/token", async (req, res) => {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ message: "Sign in first" });
    try {
        // The ref must be the one this user consented with in SpreeWe (POST /v1/apps/{appId}/grants)
        const token = await spreewe.userToken(`yourapp-user-${me.id}`, ["realtime:connect", "messages:read"]);
        res.json({ accessToken: token.accessToken, expiresAt: token.expiresAt });
    } catch (error) {
        if (error instanceof SpreeWeApiError && error.status === 403) {
            // Not authorised yet (or consent withdrawn): send them to your "Connect SpreeWe" flow
            return res.status(403).json({ message: "Connect your SpreeWe account first" });
        }
        res.status(502).json({ message: "SpreeWe is unavailable" });
    }
});

app.post("/spreewe/logout", async (req, res) => {
    const token = String(req.body?.accessToken || "");
    if (token) await spreewe.revoke(token).catch(() => undefined);
    res.status(204).end();
});

app.listen(Number(process.env.PORT || 3000));
