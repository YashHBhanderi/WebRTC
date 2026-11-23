/**
 * Clerk test double, shared by the Vitest process (test/setup/env.ts) and child test instances
 * (test/support/instance.ts). A "session" is JSON: { sub: "user_x", org?: "org_y", role?: "org:admin" }.
 * HTTP: header x-test-auth. Socket: handshake auth.token. Anything else is unauthenticated.
 */
const parse = (raw: unknown) => {
    try {
        return typeof raw === "string" ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};
export const clerkDouble = {
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    getAuth: (req: any) => {
        const a = parse(req.headers["x-test-auth"]);
        return a?.sub
            ? { isAuthenticated: true, userId: a.sub, orgId: a.org ?? null, orgRole: a.org ? (a.role ?? "org:member") : null, orgSlug: a.org ? "slug" : null, sessionClaims: { iat: a.iat ?? Math.floor(Date.now() / 1000), ...(a.fva ? { fva: a.fva } : {}) } }
            : { isAuthenticated: false, userId: null };
    },
    verifyToken: async (token: string) => {
        const a = parse(token);
        if (!a?.sub) {
            throw Object.assign(new Error("invalid test token"), { reason: "test-invalid" });
        }
        // Same shape as a real v2 session token
        const iat = a.iat ?? Math.floor(Date.now() / 1000);
        return a.org
            ? { sub: a.sub, v: 2, iat, o: { id: a.org, rol: String(a.role ?? "org:member").replace(/^org:/, ""), slg: "slug" } }
            : { sub: a.sub, v: 2, iat };
    },
    clerkClient: {
        users: {
            // Verified emails: an explicit override (clerkTestState.emails) or the stored user's email
            getUser: async (clerkUserId: string) => {
                const override = clerkTestState.emails.get(clerkUserId);
                if (override) return { id: clerkUserId, emailAddresses: override.map((e) => ({ emailAddress: e.email, verification: { status: e.verified ? "verified" : "unverified" } })) };
                const User = (await import("../../src/models/userModel")).default;
                const { runAsSystem } = await import("../../src/tenancy/context");
                const u = await runAsSystem(() => User.findOne({ clerkId: clerkUserId }).select("email").lean(), "test-double");
                if (!u) throw Object.assign(new Error("not found"), { errors: [{ code: "resource_not_found" }] });
                return { id: clerkUserId, emailAddresses: [{ emailAddress: (u as any).email, verification: { status: "verified" } }] };
            },
        },
        organizations: {
            createOrganization: async (p: { name: string; createdBy?: string }) => {
                fail("createOrganization");
                const id = "org_" + Math.random().toString(36).slice(2, 12);
                clerkTestState.orgs.set(id, { name: p.name, members: new Map(p.createdBy ? [[p.createdBy, "org:admin"]] : []) });
                return { id };
            },
            deleteOrganization: async (id: string) => {
                fail("deleteOrganization");
                if (!clerkTestState.orgs.delete(id)) throw Object.assign(new Error("nf"), { errors: [{ code: "resource_not_found" }] });
                return { id };
            },
            createOrganizationMembership: async (p: { organizationId: string; userId: string; role: string }) => {
                fail("createOrganizationMembership");
                const org = clerkTestState.orgs.get(p.organizationId);
                if (!org) throw Object.assign(new Error("nf"), { errors: [{ code: "resource_not_found" }] });
                if (org.members.has(p.userId)) throw Object.assign(new Error("dup"), { errors: [{ code: "already_a_member_in_organization" }] });
                org.members.set(p.userId, p.role);
                return {};
            },
            updateOrganizationMembership: async (p: { organizationId: string; userId: string; role: string }) => {
                fail("updateOrganizationMembership");
                clerkTestState.orgs.get(p.organizationId)?.members.set(p.userId, p.role);
                return {};
            },
            deleteOrganizationMembership: async (p: { organizationId: string; userId: string }) => {
                fail("deleteOrganizationMembership");
                const org = clerkTestState.orgs.get(p.organizationId);
                if (!org?.members.delete(p.userId)) throw Object.assign(new Error("nf"), { errors: [{ code: "resource_not_found" }] });
                return {};
            },
        },
    },
};

/** In-memory Clerk state for tests: organizations, membership, verified-email overrides, injected failures. */
export const clerkTestState = {
    orgs: new Map<string, { name: string; members: Map<string, string> }>(),
    emails: new Map<string, { email: string; verified: boolean }[]>(),
    failing: new Set<string>(),
};

function fail(op: string): void {
    if (clerkTestState.failing.has(op)) throw Object.assign(new Error("injected"), { errors: [{ code: "injected_failure" }], status: 500 });
}
