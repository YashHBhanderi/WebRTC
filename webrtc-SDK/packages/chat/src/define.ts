/** Registers the chat elements (and the shared <spreewe-provider> / <spreewe-avatar>). */
import "@spreewe/ui/define";
import { defineElement } from "@spreewe/ui";
import { SpreeWeConversationList } from "./components/conversation-list.js";
import { SpreeWeMessageList } from "./components/message-list.js";
import { SpreeWeMessageComposer } from "./components/composer.js";
import { SpreeWeChatWindow } from "./components/chat-window.js";
import { SpreeWeChat } from "./components/chat.js";

defineElement("spreewe-conversation-list", SpreeWeConversationList);
defineElement("spreewe-message-list", SpreeWeMessageList);
defineElement("spreewe-message-composer", SpreeWeMessageComposer);
defineElement("spreewe-chat-window", SpreeWeChatWindow);
defineElement("spreewe-chat", SpreeWeChat);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-conversation-list": SpreeWeConversationList;
        "spreewe-message-list": SpreeWeMessageList;
        "spreewe-message-composer": SpreeWeMessageComposer;
        "spreewe-chat-window": SpreeWeChatWindow;
        "spreewe-chat": SpreeWeChat;
    }
}
