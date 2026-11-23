/** Registers <spreewe-provider> and <spreewe-avatar>. Import once: `import "@spreewe/ui/define";` */
import { defineElement } from "./element.js";
import { SpreeWeProvider } from "./provider.js";
import { SpreeWeAvatar } from "./avatar.js";

defineElement("spreewe-provider", SpreeWeProvider);
defineElement("spreewe-avatar", SpreeWeAvatar);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-provider": SpreeWeProvider;
        "spreewe-avatar": SpreeWeAvatar;
    }
}
