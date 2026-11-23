import "@spreewe/ui/define";
import { defineElement } from "@spreewe/ui";
import { SpreeWeGroupList } from "./components/group-list.js";
import { SpreeWeGroupDetails } from "./components/group-details.js";
import { SpreeWeCreateGroup } from "./components/create-group.js";
import { SpreeWeMemberPicker } from "./components/member-picker.js";

defineElement("spreewe-group-list", SpreeWeGroupList);
defineElement("spreewe-group-details", SpreeWeGroupDetails);
defineElement("spreewe-create-group", SpreeWeCreateGroup);
defineElement("spreewe-member-picker", SpreeWeMemberPicker);

declare global {
    interface HTMLElementTagNameMap {
        "spreewe-group-list": SpreeWeGroupList;
        "spreewe-group-details": SpreeWeGroupDetails;
        "spreewe-create-group": SpreeWeCreateGroup;
        "spreewe-member-picker": SpreeWeMemberPicker;
    }
}
