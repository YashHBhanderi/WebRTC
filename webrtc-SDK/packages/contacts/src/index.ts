/**
 * @spreewe/contacts — headless contacts service plus Web Components. Importing this entry does NOT
 * register custom elements; import "@spreewe/contacts/define" once for that (or define the classes
 * under your own tags).
 */
export * from "./service.js";
export * from "./types.js";
export { SpreeWeContactList, type ContactSelectDetail } from "./components/contact-list.js";
export { SpreeWeProfileCard, type ContactBlockDetail } from "./components/profile-card.js";
export { SpreeWeContactLookup, type ConversationStartDetail } from "./components/contact-lookup.js";
export { SpreeWePresencePicker, type PresenceChangeDetail } from "./components/presence-picker.js";
export { SpreeWeProfileEditor, type ProfileSavedDetail } from "./components/profile-editor.js";
export { presenceText } from "./components/shared.js";
