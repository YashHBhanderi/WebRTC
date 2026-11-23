import "@spreewe/ui/define";
import { defineElement } from "@spreewe/ui";
import { SpreeWeCallView } from "./components/call-view.js";
import { SpreeWeCallControls } from "./components/call-controls.js";
import { SpreeWeParticipantTile } from "./components/participant-tile.js";
import { SpreeWeIncomingCall } from "./components/incoming-call.js";
import { SpreeWeCallButton } from "./components/call-button.js";

defineElement("spreewe-call-view", SpreeWeCallView);
defineElement("spreewe-call-controls", SpreeWeCallControls);
defineElement("spreewe-participant-tile", SpreeWeParticipantTile);
defineElement("spreewe-incoming-call", SpreeWeIncomingCall);
defineElement("spreewe-call-button", SpreeWeCallButton);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-call-view": SpreeWeCallView;
        "spreewe-call-controls": SpreeWeCallControls;
        "spreewe-participant-tile": SpreeWeParticipantTile;
        "spreewe-incoming-call": SpreeWeIncomingCall;
        "spreewe-call-button": SpreeWeCallButton;
    }
}
