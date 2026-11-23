/**
 * Chat only. Imports @spreewe/core, @spreewe/chat and @spreewe/e2ee; nothing from calls, meetings
 * or the other modules is bundled. OAuth 2.0 + PKCE runs entirely in the browser (no backend secret).
 *
 * App registration (Developer Portal): allowedOrigins = this page's origin (e.g. http://localhost:5173),
 * callbackUrls = the same origin + "/", scopes = the ones below.
 */
import { createClient, createOAuthClient, scopesFor, type SpreeWeClient } from "@spreewe/core";
import { enableE2ee } from "@spreewe/e2ee";
import "@spreewe/chat/define";

const apiUrl = import.meta.env.VITE_SPREEWE_API_URL as string;
const clientId = import.meta.env.VITE_SPREEWE_CLIENT_ID as string;

const oauth = createOAuthClient({
    baseUrl: apiUrl,
    clientId,
    redirectUri: `${location.origin}/`,
    // Read + send (sending requires the app's own encryption device)
    scopes: scopesFor(["chat"], { includeOptional: true }),
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let client: SpreeWeClient | null = null;

async function boot(): Promise<void> {
    if (oauth.isRedirectCallback()) {
        try {
            await oauth.handleRedirectCallback();
        } catch (e) {
            $("status").textContent = e instanceof Error ? e.message : String(e);
        }
    }
    render();
}

function render(): void {
    const signedIn = oauth.isSignedIn;
    $("signin").classList.toggle("hidden", signedIn);
    $("signout").classList.toggle("hidden", !signedIn);
    if (signedIn && !client) {
        client = createClient({ baseUrl: apiUrl, auth: oauth });
        // The browser becomes one of the user's encryption devices ("<app name> (app)")
        enableE2ee(client);
        $<any>("provider").client = client;
        client.realtime.state.subscribe((s) => ($("status").textContent = s === "connected" ? "" : s));
    }
}

$("signin").addEventListener("click", () => void oauth.signIn());
$("signout").addEventListener("click", async () => {
    client?.destroy();
    client = null;
    $<any>("provider").client = null;
    await oauth.signOut();
    render();
});
oauth.onSignedOut(() => {
    client?.destroy();
    client = null;
    $<any>("provider").client = null;
    render();
});

void boot();
