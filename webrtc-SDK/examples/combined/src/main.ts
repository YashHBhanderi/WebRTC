/**
 * Several modules in one app, connected only through events (the packages never import each other).
 * Auth: backend token exchange through examples/token-server (the credential stays on the server).
 */
import { backendTokenProvider, createClient } from "@spreewe/core";
import { enableE2ee } from "@spreewe/e2ee";
import { getChat } from "@spreewe/chat";
import { getCalls } from "@spreewe/calls";
import type { ConversationSelectDetail } from "@spreewe/chat";
import type { ContactSelectDetail, ConversationStartDetail } from "@spreewe/contacts";
import type { MeetingJoinDetail } from "@spreewe/meetings";
import type { NotificationSelectDetail } from "@spreewe/notifications";
import "@spreewe/chat/define";
import "@spreewe/calls/define";
import "@spreewe/groups/define";
import "@spreewe/contacts/define";
import "@spreewe/meetings/define";
import "@spreewe/notifications/define";
import "@spreewe/files/define";

const apiUrl = import.meta.env.VITE_SPREEWE_API_URL as string;
const tokenUrl = (import.meta.env.VITE_TOKEN_URL as string) || "http://localhost:8787/spreewe-token";

const client = createClient({
    baseUrl: apiUrl,
    auth: backendTokenProvider({
        fetchToken: async () => {
            const res = await fetch(tokenUrl, { method: "POST", credentials: "include" });
            if (!res.ok) throw new Error(`Token server: ${res.status}`);
            return res.json();
        },
    }),
});
enableE2ee(client);
document.querySelector("spreewe-provider")!.client = client;

const chat = getChat(client);
const calls = getCalls(client);
const $ = <K extends keyof HTMLElementTagNameMap>(sel: string) => document.querySelector(sel) as HTMLElementTagNameMap[K];
const chatEl = $<"spreewe-chat">("#chat");

// ---- tabs
function showTab(id: string): void {
    document.querySelectorAll("main > section").forEach((s) => s.classList.toggle("active", s.id === id));
    document.querySelectorAll("nav button").forEach((b) => b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.tab === id)));
}
document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));

function openConversation(conversationId: string): void {
    showTab("chat-view");
    chatEl.conversationId = conversationId;
    syncChatActions(conversationId);
}

// ---- chat header: call buttons and group info follow the selected conversation
function syncChatActions(conversationId: string): void {
    $<"spreewe-call-button">("#call-audio").conversationId = conversationId;
    $<"spreewe-call-button">("#call-video").conversationId = conversationId;
    const isGroup = !!chat.findConversation(conversationId)?.isGroup;
    $<"button">("#group-toggle").hidden = !isGroup;
    $<"spreewe-group-details">("#group-details").groupId = isGroup ? conversationId : "";
    if (!isGroup) $<"div">("#group-panel").hidden = true;
}
chatEl.addEventListener("spreewe-conversation-select", (e) => syncChatActions((e as CustomEvent<ConversationSelectDetail>).detail.conversationId));
$<"button">("#group-toggle").onclick = () => ($<"div">("#group-panel").hidden = !$<"div">("#group-panel").hidden);
document.addEventListener("spreewe-group-left", () => (($<"div">("#group-panel").hidden = true), (chatEl.conversationId = "")));
document.addEventListener("spreewe-group-deleted", () => (($<"div">("#group-panel").hidden = true), (chatEl.conversationId = "")));

// ---- notifications → open the conversation they're about
document.addEventListener("spreewe-notification-select", (e) => {
    const { conversationId } = (e as CustomEvent<NotificationSelectDetail>).detail;
    if (conversationId) openConversation(conversationId);
});

// ---- people → start or open a direct chat
document.addEventListener("spreewe-contact-message", async (e) => {
    const { userId } = (e as CustomEvent<ContactSelectDetail>).detail;
    openConversation(await chat.openDirect(userId));
});
document.addEventListener("spreewe-conversation-start", (e) => openConversation((e as CustomEvent<ConversationStartDetail>).detail.conversationId));
document.addEventListener("spreewe-group-created", (e) => openConversation((e as CustomEvent<{ groupId: string }>).detail.groupId));

// ---- meetings → join the meeting's call (calls module)
document.addEventListener("spreewe-meeting-join", async (e) => {
    const { conversationId } = (e as CustomEvent<MeetingJoinDetail>).detail;
    const active = await calls.activeCall(conversationId);
    if (active) await calls.accept(active.callId, { callType: "video" });
    else await calls.startCall(conversationId, "video", { mode: "meetNow" });
});

document.addEventListener("spreewe-error", (e) => console.warn("SpreeWe:", (e as CustomEvent<{ error: unknown }>).detail?.error));
