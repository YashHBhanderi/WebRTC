/**
 * @spreewe/chat — headless chat service plus Web Components. Importing this entry does NOT register
 * custom elements; import "@spreewe/chat/define" once for that (or define the classes under your own tags).
 */
export * from "./service.js";
export * from "./types.js";
export { SpreeWeConversationList, type ConversationSelectDetail } from "./components/conversation-list.js";
export { SpreeWeMessageList, type MessageActionDetail } from "./components/message-list.js";
export { SpreeWeMessageComposer } from "./components/composer.js";
export { SpreeWeChatWindow } from "./components/chat-window.js";
export { SpreeWeChat } from "./components/chat.js";
export { previewText, typeLabel, QUICK_EMOJI, EMOJI_SET } from "./components/shared.js";
