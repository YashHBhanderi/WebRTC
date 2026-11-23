# Examples

Vite apps that use the packages from this workspace. Build the packages first (`npm run build` in
`webrtc-SDK`), copy `.env.example` to `.env` in the example, fill it in, then `npx vite` in its folder.

| Example | Auth | App registration (Developer Portal) |
|---|---|---|
| `chat-only` | OAuth 2.0 + PKCE in the browser | allowedOrigins `http://localhost:5173`, callbackUrls `http://localhost:5173/`, scopes: `scopesFor(["chat"], { includeOptional: true })` |
| `calls-only` | OAuth 2.0 + PKCE | same origin / callback; calls scopes + `conversations:read`, `groups:read` |
| `combined` | Backend exchange via `token-server` | allowedOrigins `http://localhost:5173`; the scopes of every module; a credential for the token server |

`token-server` (no dependencies): `SPREEWE_API_URL=… SPREEWE_KEY_ID=swk_… SPREEWE_SECRET=sws_… SPREEWE_DEMO_USER_ID=… node server.mjs`.
It deliberately skips user authentication and always issues tokens for one demo user: never deploy it.

The SpreeWe server also needs the user's consent for the app (OAuth examples: the consent page;
token server: `POST /v1/consent-requests` once, or approve the app from the SpreeWe web app).
For calls you need two signed-in users (two browsers or profiles) and TURN for anything beyond localhost.
