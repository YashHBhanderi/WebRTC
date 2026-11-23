import { html, type TemplateResult } from "lit";
import { t } from "@spreewe/ui";
import type { BodyState, ConversationSummary } from "../types.js";

/** Label for a message without text (attachments, calls) */
export function typeLabel(type: string | undefined): string {
    switch (type) {
        case "image":
            return t("chat.preview.photo");
        case "video":
            return t("chat.preview.video");
        case "audio":
            return t("chat.preview.audio");
        case "pdf":
            return t("chat.preview.pdf");
        case "file":
            return t("chat.preview.file");
        case "call":
            return t("chat.preview.call");
        case "recording":
            return t("chat.preview.recording");
        default:
            return "";
    }
}

export function bodyStateText(state: BodyState): string {
    switch (state) {
        case "pending":
            return t("chat.messages.pendingKey");
        case "failed":
            return t("chat.messages.failedKey");
        case "locked":
            return t("chat.messages.locked");
        case "withheld":
            return t("chat.messages.withheld");
        default:
            return "";
    }
}

/** List preview for a conversation */
export function previewText(c: ConversationSummary, me: string): string {
    const prefix = c.lastMessageAuthorId && c.lastMessageAuthorId === me && c.lastMessageType !== "system" ? t("chat.list.you") : "";
    if (c.previewState !== "ok") return prefix + t("chat.preview.encrypted");
    const text = c.preview || typeLabel(c.lastMessageType);
    return text ? prefix + text : "";
}

export const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export const EMOJI_SET = [
    "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤔", "😐", "🙄", "😴",
    "😮", "😢", "😭", "😡", "🥳", "🤗", "🤝", "👍", "👎", "👏", "🙌", "🙏",
    "💪", "👀", "🔥", "✨", "🎉", "❤️", "💔", "✅", "❌", "⚠️", "💡", "📌",
    "📎", "📅", "⏰", "☕", "🍕", "🚀", "🌟", "💯", "😅", "😇", "🙃", "😉",
];

export function spinner(): TemplateResult {
    return html`<span class="spinner" role="status" aria-label=${t("common.loading")}></span>`;
}
