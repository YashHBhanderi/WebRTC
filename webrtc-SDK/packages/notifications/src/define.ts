/** Registers the notification elements (and the shared <spreewe-provider> / <spreewe-avatar>). */
import "@spreewe/ui/define";
import { defineElement } from "@spreewe/ui";
import { SpreeWeNotificationList } from "./components/notification-list.js";
import { SpreeWeNotificationBell } from "./components/notification-bell.js";

defineElement("spreewe-notification-list", SpreeWeNotificationList);
defineElement("spreewe-notification-bell", SpreeWeNotificationBell);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-notification-list": SpreeWeNotificationList;
        "spreewe-notification-bell": SpreeWeNotificationBell;
    }
}
