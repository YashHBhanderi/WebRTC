/** Registers the meetings elements (and the shared <spreewe-provider> / <spreewe-avatar>). */
import "@spreewe/ui/define";
import { defineElement } from "@spreewe/ui";
import { SpreeWeMeetingList } from "./components/meeting-list.js";
import { SpreeWeMeetingScheduler } from "./components/meeting-scheduler.js";
import { SpreeWeMeetingJoin } from "./components/meeting-join.js";

defineElement("spreewe-meeting-list", SpreeWeMeetingList);
defineElement("spreewe-meeting-scheduler", SpreeWeMeetingScheduler);
defineElement("spreewe-meeting-join", SpreeWeMeetingJoin);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-meeting-list": SpreeWeMeetingList;
        "spreewe-meeting-scheduler": SpreeWeMeetingScheduler;
        "spreewe-meeting-join": SpreeWeMeetingJoin;
    }
}
