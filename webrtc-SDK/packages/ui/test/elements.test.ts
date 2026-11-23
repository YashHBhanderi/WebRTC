import { describe, expect, it } from "vitest";
import { backendTokenProvider, createClient, type SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, applyTheme, cssForTheme, defineElement, setDefaultClient, setStrings, t, themes } from "@spreewe/ui";
import "@spreewe/ui/define";
import "@spreewe/chat/define";

const client = (fetchImpl?: typeof fetch): SpreeWeClient =>
    createClient({ baseUrl: "https://api.test", auth: backendTokenProvider({ fetchToken: async () => ({ accessToken: "x.y.z", expiresIn: 600 }) }), fetch: fetchImpl });

class Probe extends SpreeWeElement {
    changes: (SpreeWeClient | null)[] = [];
    protected override clientChanged(c: SpreeWeClient | null): void {
        this.changes.push(c);
    }
    get resolved() {
        return this.sw;
    }
}
defineElement("test-probe", Probe);

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("client resolution", () => {
    it("uses the nearest provider, updates when its client changes, prefers an explicit client", async () => {
        const a = client();
        const b = client();
        const provider = document.createElement("spreewe-provider");
        const probe = document.createElement("test-probe") as Probe;
        provider.appendChild(probe);
        document.body.appendChild(provider);
        provider.client = a;
        await provider.updateComplete;
        expect(probe.resolved).toBe(a);
        provider.client = b;
        await provider.updateComplete;
        expect(probe.resolved).toBe(b);
        const explicit = client();
        probe.client = explicit;
        await probe.updateComplete;
        expect(probe.resolved).toBe(explicit);
        provider.remove();
    });

    it("falls back to setDefaultClient()", async () => {
        const c = client();
        setDefaultClient(c);
        const probe = document.createElement("test-probe") as Probe;
        document.body.appendChild(probe);
        await tick();
        expect(probe.resolved).toBe(c);
        setDefaultClient(null);
        expect(probe.resolved).toBeNull();
        probe.remove();
    });
});

describe("theming and strings", () => {
    it("applies a theme as --sw-* custom properties and removes it again", () => {
        const el = document.createElement("div");
        const remove = applyTheme(el, { ...themes.neutral, brand: "#0a66c2", radius: "4px", tokens: { "--sw-space-3": "10px" } });
        expect(el.style.getPropertyValue("--sw-color-brand")).toBe("#0a66c2");
        expect(el.style.getPropertyValue("--sw-radius")).toBe("4px");
        expect(el.style.getPropertyValue("--sw-space-3")).toBe("10px");
        remove();
        expect(el.style.getPropertyValue("--sw-color-brand")).toBe("");
        expect(cssForTheme(".app", { brand: "red" })).toContain("--sw-color-brand: red;");
    });

    it("overrides strings with placeholders", () => {
        expect(t("chat.window.typing.one", { name: "Ana" })).toBe("Ana is typing…");
        setStrings({ "chat.window.typing.one": "{name} écrit…" });
        expect(t("chat.window.typing.one", { name: "Ana" })).toBe("Ana écrit…");
    });
});

describe("chat components", () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    it("<spreewe-conversation-list> renders the server's conversations and fires a select event", async () => {
        const fetchImpl = (async (url: string) => {
            if (url.endsWith("/v1/me")) return json({ data: { user: { _id: "me1", username: "Me" }, context: { tenantId: null, role: null } } });
            if (url.includes("/groupConversations")) return json({ success: true, data: [] });
            if (url.includes("/conversations"))
                return json({ success: true, data: [{ _id: "c1", unreadCount: 2, receiver: { _id: "u2", username: "Ana Diaz" }, lastMessage: { _id: "m1", userId: "u2", content: "", type: "image", createdAt: new Date().toISOString() } }] });
            if (url.includes("/config")) return json({ data: {} });
            return json({ data: null });
        }) as typeof fetch;
        const c = client(fetchImpl);
        // No socket server in unit tests: realtime.connect() is stubbed (covered by integration tests)
        (c.realtime as any).connect = async () => undefined;
        const list = document.createElement("spreewe-conversation-list");
        list.client = c;
        document.body.appendChild(list);
        const root = () => list.shadowRoot!;
        for (let i = 0; i < 50 && !root().querySelector("button.item"); i++) await new Promise((r) => setTimeout(r, 10));
        const item = root().querySelector("button.item")!;
        expect(item.textContent).toContain("Ana Diaz");
        expect(item.textContent).toContain("Photo");
        expect(root().querySelector(".badge")?.textContent?.trim()).toBe("2");
        const picked = new Promise<string>((resolve) => list.addEventListener("spreewe-conversation-select", (e) => resolve((e as CustomEvent).detail.conversationId)));
        (item as HTMLButtonElement).click();
        expect(await picked).toBe("c1");
        list.remove();
    });
});
