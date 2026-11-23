/** Registers the files elements (and the shared <spreewe-provider> / <spreewe-avatar>). */
import "@spreewe/ui/define";
import { defineElement } from "@spreewe/ui";
import { SpreeWeFileList } from "./components/file-list.js";
import { SpreeWeSharedMedia } from "./components/shared-media.js";

defineElement("spreewe-file-list", SpreeWeFileList);
defineElement("spreewe-shared-media", SpreeWeSharedMedia);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-file-list": SpreeWeFileList;
        "spreewe-shared-media": SpreeWeSharedMedia;
    }
}
