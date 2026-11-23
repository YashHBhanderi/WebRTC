import { LitElement, type PropertyDeclarations, type PropertyValues } from "lit";
import type { ReadableStore, SpreeWeClient, Unsubscribe } from "@spreewe/core";
import { registerOrphan } from "./orphans.js";

/** Asked by components on connect; answered by the nearest <spreewe-provider>. */
export const CLIENT_REQUEST_EVENT = "spreewe-client-request";

export interface ClientRequestDetail {
    /** Called with the provider's client now and whenever it changes; returns nothing */
    subscribe(listener: (client: SpreeWeClient | null) => void): Unsubscribe;
    /** Set by the provider that answered */
    answered: boolean;
}

let defaultClient: SpreeWeClient | null = null;
const defaultListeners = new Set<(c: SpreeWeClient | null) => void>();

/**
 * Use one client for every SpreeWe component on the page that has no `client` property and no
 * <spreewe-provider> ancestor.
 */
export function setDefaultClient(client: SpreeWeClient | null): void {
    defaultClient = client;
    for (const l of [...defaultListeners]) l(client);
}

export function getDefaultClient(): SpreeWeClient | null {
    return defaultClient;
}

/**
 * Base class of every SpreeWe component.
 *
 * Client resolution: the `client` property, else the nearest <spreewe-provider>, else
 * setDefaultClient(). `clientChanged()` runs whenever the resolved client changes (also null).
 *
 * `watch(store)` subscribes while the element is connected and re-renders on every change.
 */
export class SpreeWeElement extends LitElement {
    static override properties: PropertyDeclarations = {
        client: { attribute: false },
    };

    /** Explicit client; takes precedence over a provider */
    declare client: SpreeWeClient | null | undefined;

    private resolvedClient: SpreeWeClient | null = null;
    private contextClient: SpreeWeClient | null = null;
    private contextOff: Unsubscribe | null = null;
    private readonly watched: { store: ReadableStore<unknown>; off: Unsubscribe | null; cb?: (v: any) => void }[] = [];
    private readonly disposers: Unsubscribe[] = [];

    /** The client in use (explicit, provider or default) */
    protected get sw(): SpreeWeClient | null {
        return this.resolvedClient;
    }

    override connectedCallback(): void {
        super.connectedCallback();
        this.requestContext();
        for (const w of this.watched) if (!w.off) w.off = this.subscribeStore(w.store, w.cb);
        this.resolve();
    }

    private requestContext(): void {
        this.contextOff?.();
        const detail: ClientRequestDetail = {
            answered: false,
            subscribe: () => () => undefined,
        };
        this.dispatchEvent(new CustomEvent<ClientRequestDetail>(CLIENT_REQUEST_EVENT, { detail, bubbles: true, composed: true }));
        if (detail.answered) {
            this.contextOff = detail.subscribe((c) => {
                this.contextClient = c;
                this.resolve();
            });
        } else {
            const l = (c: SpreeWeClient | null) => {
                this.contextClient = c;
                this.resolve();
            };
            defaultListeners.add(l);
            // A <spreewe-provider> around us that upgrades later answers then
            const offOrphan = registerOrphan(this, () => {
                this.requestContext();
                this.resolve();
            });
            this.contextOff = () => {
                defaultListeners.delete(l);
                offOrphan();
            };
            this.contextClient = defaultClient;
        }
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.contextOff?.();
        this.contextOff = null;
        for (const w of this.watched) {
            w.off?.();
            w.off = null;
        }
        for (const d of this.disposers.splice(0)) d();
        // Re-attached later: clientChanged() runs again and re-subscribes (module services keep their data)
        this.resolvedClient = null;
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("client")) this.resolve();
    }

    private resolve(): void {
        const next = this.client ?? this.contextClient ?? null;
        if (next === this.resolvedClient) return;
        const prev = this.resolvedClient;
        this.resolvedClient = next;
        for (const d of this.disposers.splice(0)) d();
        this.clientChanged(next, prev);
        this.requestUpdate();
    }

    /** Override to (re)load data when the client becomes available or changes. */
    protected clientChanged(_client: SpreeWeClient | null, _previous: SpreeWeClient | null): void {}

    /**
     * Keep a store's value in sync with rendering while connected. Returns the store for chaining.
     * Optional `cb` also runs on every value.
     */
    protected watch<T>(store: ReadableStore<T>, cb?: (value: T) => void): ReadableStore<T> {
        const entry = { store: store as ReadableStore<unknown>, off: null as Unsubscribe | null, cb };
        this.watched.push(entry);
        if (this.isConnected) entry.off = this.subscribeStore(store, cb);
        return store;
    }

    /** Stop watching a store started with watch() */
    protected unwatch(store: ReadableStore<unknown>): void {
        for (let i = this.watched.length - 1; i >= 0; i--) {
            if (this.watched[i].store === store) {
                this.watched[i].off?.();
                this.watched.splice(i, 1);
            }
        }
    }

    /**
     * Subscribe to a store for as long as the current client is in use (released when the client
     * changes or the element disconnects) and re-render on every change. Call from clientChanged().
     */
    protected observe<T>(store: ReadableStore<T>, cb?: (value: T) => void): void {
        let first = true;
        this.disposers.push(
            store.subscribe((v) => {
                cb?.(v);
                if (!first) this.requestUpdate();
                first = false;
            }),
        );
    }

    /** Run `off` when the client changes or the element disconnects. */
    protected untilClientChanges(off: Unsubscribe): void {
        this.disposers.push(off);
    }

    private subscribeStore<T>(store: ReadableStore<T>, cb?: (v: T) => void): Unsubscribe {
        let first = true;
        return store.subscribe((v) => {
            cb?.(v);
            if (!first) this.requestUpdate();
            first = false;
        });
    }

    /** Dispatch a composed, bubbling CustomEvent (all SpreeWe events are prefixed "spreewe-"). */
    protected fire<T>(name: string, detail?: T, options: { cancelable?: boolean } = {}): boolean {
        return this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true, cancelable: !!options.cancelable }));
    }
}

/** Define a custom element once (safe when several bundles register the same tags). */
export function defineElement(tag: string, ctor: CustomElementConstructor): void {
    if (typeof customElements === "undefined") return;
    if (!customElements.get(tag)) customElements.define(tag, ctor);
}
