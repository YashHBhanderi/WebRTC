/**
 * Calling only. Imports @spreewe/core and @spreewe/calls; chat and end-to-end encryption are not
 * bundled. mediasoup-client is loaded on the first call.
 *
 * Scopes: calls (required + host controls) and conversations:read / groups:read to list where the
 * user can call. Register this page's origin in the app's allowedOrigins and callbackUrls.
 */
import { createClient, createOAuthClient, scopesFor, type DirectConversation, type GroupConversation, type SpreeWeClient } from "@spreewe/core";
import "@spreewe/calls/define";

const apiUrl = import.meta.env.VITE_SPREEWE_API_URL as string;
const oauth = createOAuthClient({
    baseUrl: apiUrl,
    clientId: import.meta.env.VITE_SPREEWE_CLIENT_ID as string,
    redirectUri: `${location.origin}/`,
    scopes: [...scopesFor(["calls"], { includeOptional: true }), "conversations:read", "groups:read"],
});

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let client: SpreeWeClient | null = null;

/** Where the user can call: their direct chats and groups (plain REST through @spreewe/core). */
async function loadConversations(c: SpreeWeClient): Promise<void> {
    const [direct, groups] = await Promise.all([
        c.http.get<DirectConversation[]>("/conversations"),
        c.http.get<GroupConversation[]>("/groupConversations").catch(() => [] as GroupConversation[]),
    ]);
    const options = [
        ...direct.map((d) => new Option(d.receiver?.username || "Direct chat", String(d._id))),
        ...groups.map((g) => new Option(g.groupName || "Group", String(g._id))),
    ];
    const select = $<HTMLSelectElement>("conversation");
    select.replaceChildren(...options);
    const pick = () => {
        $<HTMLElementTagNameMap["spreewe-call-button"]>("audio").conversationId = select.value;
        $<HTMLElementTagNameMap["spreewe-call-button"]>("video").conversationId = select.value;
    };
    select.onchange = pick;
    pick();
}

async function boot(): Promise<void> {
    if (oauth.isRedirectCallback()) await oauth.handleRedirectCallback().catch((e: Error) => alert(e.message));
    const signedIn = oauth.isSignedIn;
    $("signin").classList.toggle("hidden", signedIn);
    $("signout").classList.toggle("hidden", !signedIn);
    $("picker").classList.toggle("hidden", !signedIn);
    if (signedIn) {
        client = createClient({ baseUrl: apiUrl, auth: oauth });
        $<HTMLElementTagNameMap["spreewe-provider"]>("provider").client = client;
        await loadConversations(client);
    }
}

$("signin").onclick = () => void oauth.signIn();
$("signout").onclick = async () => {
    client?.destroy();
    await oauth.signOut();
    location.reload();
};
void boot();
