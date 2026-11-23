import { SpreeWeError, Store, isSpreeWeError, type GroupConversation, type ReadableStore, type SpreeWeClient, type Unsubscribe, type UserSummary } from "@spreewe/core";

const GROUPS_SERVICE = Symbol.for("spreewe.groups");

export function getGroups(client: SpreeWeClient): GroupsService {
    return client.service(GROUPS_SERVICE, (c) => new GroupsService(c));
}

export interface GroupDetails {
    id: string;
    name: string;
    description: string;
    /** Storage key or URL (resolve with client.mediaUrl) */
    avatar: string;
    admins: string[];
    members: UserSummary[];
}

export interface GroupListItem {
    id: string;
    name: string;
    avatar: string;
    description: string;
    memberCount: number;
    unread: number;
    lastMessageAt?: string;
    scope?: "global" | "tenant" | "external";
}

export interface GroupListState {
    items: GroupListItem[];
    loading: boolean;
    loaded: boolean;
    error: Error | null;
}

export interface DetailsState {
    group: GroupDetails | null;
    loading: boolean;
    error: Error | null;
    /** The user is no longer a member (removed, left, or the group was deleted) */
    gone: false | "removed" | "left" | "deleted";
}

export interface CreateGroupInput {
    name: string;
    description?: string;
    /** Other members (the creator is added by the server). At least 2 are needed. */
    memberIds: string[];
    photo?: Blob;
}

/**
 * Groups: list, details, creation and member management. Membership changes go through the same
 * Socket.IO handlers as the SpreeWe apps, so every member sees them live.
 *
 * Scopes: groups:read (list, details, live events), groups:write (create, rename, description,
 * photo; files:write for the photo upload), groups:manage (add / remove members, promote / demote
 * admins, leave), conversations:delete (delete a group you administer). The server enforces group
 * admin rights on top of the scopes.
 */
export class GroupsService {
    readonly client: SpreeWeClient;
    private readonly listStore = new Store<GroupListState>({ items: [], loading: false, loaded: false, error: null });
    private readonly details = new Map<string, Store<DetailsState>>();
    private readonly offs: Unsubscribe[] = [];
    private wired = false;
    private listLoad: Promise<void> | null = null;

    constructor(client: SpreeWeClient) {
        this.client = client;
    }

    get groups(): ReadableStore<GroupListState> {
        return this.listStore;
    }

    private async start(): Promise<void> {
        if (!this.wired) {
            this.wired = true;
            const rt = this.client.realtime;
            this.offs.push(
                rt.on<{ groupId: string; group?: GroupPayload }>("group:updated", (e) => e?.group && this.apply(String(e.groupId), e.group)),
                rt.on<{ groupId: string }>("group:added", () => void this.loadGroups({ refresh: true }).catch(() => undefined)),
                rt.on<{ groupId: string; reason?: "removed" | "left" | "deleted" }>("group:removed", (e) => {
                    const id = String(e?.groupId || "");
                    this.listStore.update((s) => ({ ...s, items: s.items.filter((g) => g.id !== id) }));
                    this.details.get(id)?.update((d) => ({ ...d, gone: e.reason || "removed" }));
                }),
                rt.onConnect(() => {
                    if (this.listStore.value.loaded) void this.loadGroups({ refresh: true }).catch(() => undefined);
                    for (const [id, store] of this.details) if (store.value.group && !store.value.gone) void this.loadDetails(id).catch(() => undefined);
                }),
            );
        }
        await this.client.realtime.connect();
    }

    // ------------------------------------------------------------------ list

    loadGroups(options: { archived?: boolean; refresh?: boolean } = {}): Promise<void> {
        if (this.listLoad && !options.refresh) return this.listLoad;
        this.listStore.update((s) => ({ ...s, loading: true, error: null }));
        this.listLoad = (async () => {
            try {
                await this.start();
                const rows = await this.client.http.get<GroupConversation[]>("/groupConversations", { query: options.archived ? { archived: "true" } : undefined });
                const items = (rows || []).map((g) => {
                    this.client.people.remember(g.members || []);
                    return {
                        id: String(g._id),
                        name: g.groupName || "Group",
                        avatar: g.groupAvatar || "",
                        description: g.groupDescription || "",
                        memberCount: (g.members || []).length,
                        unread: g.unreadCount || 0,
                        lastMessageAt: g.lastMessage?.createdAt || g.timestamp,
                        scope: g.scope,
                    };
                });
                this.listStore.set({ items, loading: false, loaded: true, error: null });
            } catch (e) {
                this.listStore.update((s) => ({ ...s, loading: false, error: e as Error }));
                this.listLoad = null;
                throw e;
            }
        })();
        return this.listLoad;
    }

    // ------------------------------------------------------------------ details

    /** Live details of one group (loaded on first call). */
    group(groupId: string): ReadableStore<DetailsState> {
        let store = this.details.get(groupId);
        if (!store) {
            store = new Store<DetailsState>({ group: null, loading: false, error: null, gone: false });
            this.details.set(groupId, store);
            void this.loadDetails(groupId).catch(() => undefined);
        }
        return store;
    }

    async loadDetails(groupId: string): Promise<GroupDetails> {
        const store = this.details.get(groupId) || new Store<DetailsState>({ group: null, loading: false, error: null, gone: false });
        this.details.set(groupId, store);
        store.update((s) => ({ ...s, loading: true, error: null }));
        try {
            await this.start();
            const raw = await this.client.http.get<{
                _id?: string;
                groupName?: string;
                groupDescription?: string;
                groupAvatar?: string;
                groupAdmins?: string[];
                membersDetails?: UserSummary[];
            }>(`/conversations/${encodeURIComponent(groupId)}/group`);
            const group: GroupDetails = {
                id: groupId,
                name: raw.groupName || "Group",
                description: raw.groupDescription || "",
                avatar: raw.groupAvatar || "",
                admins: (raw.groupAdmins || []).map(String),
                members: raw.membersDetails || [],
            };
            this.client.people.remember(group.members);
            this.client.people.seedPresence(group.members);
            store.set({ group, loading: false, error: null, gone: false });
            return group;
        } catch (e) {
            const gone = isSpreeWeError(e) && (e.status === 403 || e.status === 404);
            store.update((s) => ({ ...s, loading: false, error: e as Error, gone: gone ? "removed" : s.gone }));
            throw e;
        }
    }

    /** Apply a group payload from an event or an ack (members may be ids or profiles) */
    private apply(groupId: string, g: GroupPayload): void {
        const store = this.details.get(groupId);
        const current = store?.value.group;
        const members: UserSummary[] = Array.isArray(g.members)
            ? g.members.map((m) => (typeof m === "object" && m ? (m as UserSummary) : current?.members.find((x) => String(x._id) === String(m)) || { _id: String(m), username: "" }))
            : current?.members || [];
        this.client.people.remember(members);
        const next: GroupDetails = {
            id: groupId,
            name: g.groupName ?? current?.name ?? "Group",
            description: g.groupDescription ?? current?.description ?? "",
            avatar: g.groupAvatar ?? current?.avatar ?? "",
            admins: (g.groupAdmins || current?.admins || []).map(String),
            members,
        };
        store?.update((s) => ({ ...s, group: next }));
        // Members whose profile we don't have yet (ids only): fetch details once
        if (store && members.some((m) => !m.username)) void this.loadDetails(groupId).catch(() => undefined);
        this.listStore.update((s) => ({
            ...s,
            items: s.items.map((i) => (i.id === groupId ? { ...i, name: next.name, avatar: next.avatar, description: next.description, memberCount: members.length } : i)),
        }));
    }

    isAdmin(group: GroupDetails | null | undefined, userId: string): boolean {
        return !!group?.admins.includes(String(userId));
    }

    // ------------------------------------------------------------------ actions

    /** Create a group (POST /conversations/group, scope groups:write). Returns the new group id. */
    async create(input: CreateGroupInput): Promise<string> {
        const name = input.name.trim();
        if (!name) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "A group needs a name." });
        if (input.memberIds.length < 2) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Add at least 2 people." });
        const form = new FormData();
        form.append("groupName", name);
        form.append("groupDescription", input.description?.trim() || "");
        form.append("groupMembers", JSON.stringify([...new Set(input.memberIds.map(String))]));
        if (input.photo) form.append("image", input.photo, (input.photo as File).name || "photo");
        const group = await this.client.http.post<{ _id: string }>("/conversations/group", undefined, { form });
        void this.loadGroups({ refresh: true }).catch(() => undefined);
        return String(group._id);
    }

    private async act<T = { group?: GroupPayload }>(event: string, payload: Record<string, unknown>): Promise<T> {
        await this.start();
        const res = await this.client.realtime.request<T & { group?: GroupPayload }>(event, payload);
        const id = String(payload.groupId);
        if (res?.group) this.apply(id, res.group);
        return res;
    }

    /** Rename or change the description (group admins). */
    update(groupId: string, patch: { name?: string; description?: string }): Promise<unknown> {
        return this.act("group:update", { groupId, groupName: patch.name, groupDescription: patch.description });
    }

    /** New group photo: uploaded (POST /upload purpose=group-avatar, files:write), then applied. */
    async setPhoto(groupId: string, photo: Blob): Promise<void> {
        const form = new FormData();
        form.append("purpose", "group-avatar");
        form.append("groupId", groupId);
        form.append("file", photo, (photo as File).name || "photo");
        const uploaded = await this.client.http.post<{ storageKey: string }>("/upload", undefined, { form });
        await this.act("group:update", { groupId, groupAvatarKey: uploaded.storageKey });
    }

    addMembers(groupId: string, userIds: string[]): Promise<{ added?: string[] }> {
        return this.act("group:add-member", { groupId, userIds });
    }

    removeMember(groupId: string, userId: string): Promise<unknown> {
        return this.act("group:remove-member", { groupId, userId });
    }

    promote(groupId: string, userId: string): Promise<unknown> {
        return this.act("group:promote-admin", { groupId, userId });
    }

    demote(groupId: string, userId: string): Promise<unknown> {
        return this.act("group:remove-admin", { groupId, userId });
    }

    /** Leave (if you're the last admin, the earliest remaining member becomes admin). */
    async leave(groupId: string): Promise<void> {
        await this.act("group:leave", { groupId });
        this.details.get(groupId)?.update((d) => ({ ...d, gone: "left" }));
        this.listStore.update((s) => ({ ...s, items: s.items.filter((g) => g.id !== groupId) }));
    }

    /** Delete for everyone (group admins; DELETE /conversations/:id, scope conversations:delete). */
    async delete(groupId: string): Promise<void> {
        await this.client.http.delete(`/conversations/${encodeURIComponent(groupId)}`);
        this.details.get(groupId)?.update((d) => ({ ...d, gone: "deleted" }));
        this.listStore.update((s) => ({ ...s, items: s.items.filter((g) => g.id !== groupId) }));
    }

    destroy(): void {
        this.offs.splice(0).forEach((off) => off());
    }
}

interface GroupPayload {
    _id?: string;
    groupName?: string;
    groupDescription?: string;
    groupAvatar?: string;
    groupAdmins?: string[];
    members?: (UserSummary | string)[];
}
