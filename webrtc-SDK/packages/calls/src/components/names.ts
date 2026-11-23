import type { SpreeWeClient, UserSummary } from "@spreewe/core";

/** Small per-client profile cache for call UIs (profiles come from client.people). */
export class NameBook {
    private readonly users = new Map<string, UserSummary>();
    private readonly pending = new Set<string>();

    constructor(private readonly client: SpreeWeClient, private readonly onChange: () => void) {}

    get(userId: string): UserSummary | undefined {
        const u = this.users.get(userId);
        if (!u && !this.pending.has(userId)) {
            this.pending.add(userId);
            this.client.people.profile(userId).then(
                (p) => {
                    this.users.set(userId, p);
                    this.onChange();
                },
                () => undefined,
            );
        }
        return u;
    }

    name(userId: string, fallback: string): string {
        return this.get(userId)?.username || fallback;
    }
}
