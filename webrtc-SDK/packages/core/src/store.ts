/**
 * Minimal observable value (no RxJS dependency). Listeners run synchronously on every change and
 * once immediately on subscribe. Works with any framework: wrap `subscribe` in a React hook, an
 * Angular signal, a Vue ref or a Lit controller.
 */
export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

export interface ReadableStore<T> {
    readonly value: T;
    subscribe(listener: Listener<T>): Unsubscribe;
}

export class Store<T> implements ReadableStore<T> {
    private current: T;
    private readonly listeners = new Set<Listener<T>>();

    constructor(initial: T) {
        this.current = initial;
    }

    get value(): T {
        return this.current;
    }

    set(next: T): void {
        if (Object.is(next, this.current)) return;
        this.current = next;
        for (const l of [...this.listeners]) {
            try {
                l(next);
            } catch (e) {
                // A failing listener must not stop the others
                queueMicrotask(() => {
                    throw e;
                });
            }
        }
    }

    update(fn: (value: T) => T): void {
        this.set(fn(this.current));
    }

    subscribe(listener: Listener<T>): Unsubscribe {
        this.listeners.add(listener);
        listener(this.current);
        return () => this.listeners.delete(listener);
    }

    /** Read-only view, so consumers can't call set() */
    readonly(): ReadableStore<T> {
        return this;
    }
}

/** A derived read-only store: recomputed whenever one of the sources changes. */
export function derived<S extends readonly ReadableStore<any>[], T>(
    sources: S,
    compute: (...values: { [K in keyof S]: S[K] extends ReadableStore<infer V> ? V : never }) => T,
): ReadableStore<T> {
    const read = () => compute(...(sources.map((s) => s.value) as any));
    return {
        get value() {
            return read();
        },
        subscribe(listener) {
            let last: T = read();
            listener(last);
            const offs = sources.map((s) =>
                s.subscribe(() => {
                    const next = read();
                    if (!Object.is(next, last)) {
                        last = next;
                        listener(next);
                    }
                }),
            );
            return () => offs.forEach((off) => off());
        },
    };
}

/** Typed event emitter (synchronous). */
export class Emitter<Events extends Record<string, unknown>> {
    private readonly handlers = new Map<keyof Events, Set<(payload: any) => void>>();

    on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
        let set = this.handlers.get(event);
        if (!set) this.handlers.set(event, (set = new Set()));
        set.add(handler);
        return () => set!.delete(handler);
    }

    emit<K extends keyof Events>(event: K, payload: Events[K]): void {
        for (const h of [...(this.handlers.get(event) || [])]) {
            try {
                h(payload);
            } catch (e) {
                queueMicrotask(() => {
                    throw e;
                });
            }
        }
    }

    clear(): void {
        this.handlers.clear();
    }
}
