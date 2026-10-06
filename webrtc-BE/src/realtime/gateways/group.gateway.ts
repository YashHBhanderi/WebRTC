import groupService from "../../services/group.service";
import { requireObjectId } from "../../utils/validation";
import { AuthedSocket, onAck } from "../io";
import { groupUpdated, memberLeft, memberRemoved, membersAdded } from "../group.events";

/**
 * group:* — membership and admin management. All permission checks live in GroupService;
 * every response carries the fresh group summary.
 */
export function registerGroupGateway(socket: AuthedSocket): void {
    const me = () => String(socket.data.userId);

    onAck(socket, "group:update", async ({ groupId, groupName, groupDescription, groupAvatarKey }) => {
        const group = await groupService.update(groupId, me(), { groupName, groupDescription, groupAvatarKey });
        groupUpdated(group);
        return { group };
    });

    onAck(socket, "group:add-member", async ({ groupId, userIds }) => {
        const { group, added } = await groupService.addMembers(groupId, me(), userIds);
        await membersAdded(group, me(), added);
        return { group, added };
    });

    onAck(socket, "group:remove-member", async ({ groupId, userId }) => {
        const group = await groupService.removeMember(groupId, me(), userId);
        await memberRemoved(group, me(), String(userId));
        return { group };
    });

    onAck(socket, "group:promote-admin", async ({ groupId, userId }) => {
        const group = await groupService.promoteAdmin(groupId, me(), userId);
        groupUpdated(group);
        return { group };
    });

    onAck(socket, "group:remove-admin", async ({ groupId, userId }) => {
        const group = await groupService.demoteAdmin(groupId, me(), userId);
        groupUpdated(group);
        return { group };
    });

    onAck(socket, "group:leave", async ({ groupId }) => {
        const id = requireObjectId(groupId, "groupId");
        const { group } = await groupService.leave(id, me());
        await memberLeft(id, group, me());
        return { groupId: id };
    });
}
