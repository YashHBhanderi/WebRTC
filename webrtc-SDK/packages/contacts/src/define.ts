/** Registers the contacts elements (and the shared <spreewe-provider> / <spreewe-avatar>). */
import "@spreewe/ui/define";
import { defineElement } from "@spreewe/ui";
import { SpreeWeContactList } from "./components/contact-list.js";
import { SpreeWeProfileCard } from "./components/profile-card.js";
import { SpreeWeContactLookup } from "./components/contact-lookup.js";
import { SpreeWePresencePicker } from "./components/presence-picker.js";
import { SpreeWeProfileEditor } from "./components/profile-editor.js";

defineElement("spreewe-contact-list", SpreeWeContactList);
defineElement("spreewe-profile-card", SpreeWeProfileCard);
defineElement("spreewe-contact-lookup", SpreeWeContactLookup);
defineElement("spreewe-presence-picker", SpreeWePresencePicker);
defineElement("spreewe-profile-editor", SpreeWeProfileEditor);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-contact-list": SpreeWeContactList;
        "spreewe-profile-card": SpreeWeProfileCard;
        "spreewe-contact-lookup": SpreeWeContactLookup;
        "spreewe-presence-picker": SpreeWePresencePicker;
        "spreewe-profile-editor": SpreeWeProfileEditor;
    }
}
