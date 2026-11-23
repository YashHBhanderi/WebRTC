import type { KeyValueStorage } from "./types.js";

export class MemoryStorage implements KeyValueStorage {
    private readonly map = new Map<string, string>();
    getItem(key: string): string | null {
        return this.map.has(key) ? this.map.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
}

/** Resolve a storage option. Falls back to memory when the browser blocks storage (private mode, iframes). */
export function resolveStorage(option: "session" | "local" | "memory" | KeyValueStorage | undefined): { storage: KeyValueStorage; shared: boolean } {
    if (option && typeof option === "object") return { storage: option, shared: true };
    if (option === "memory") return { storage: new MemoryStorage(), shared: false };
    const name = option === "local" ? "localStorage" : "sessionStorage";
    try {
        const s = (globalThis as Record<string, any>)[name] as Storage | undefined;
        if (s) {
            const probe = "__spreewe_probe__";
            s.setItem(probe, "1");
            s.removeItem(probe);
            // sessionStorage is per tab: no other tab can rotate the same refresh token
            return { storage: s, shared: name === "localStorage" };
        }
    } catch {
        // blocked
    }
    return { storage: new MemoryStorage(), shared: false };
}

export function readJson<T>(storage: KeyValueStorage, key: string): T | null {
    try {
        const raw = storage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

export function writeJson(storage: KeyValueStorage, key: string, value: unknown): void {
    try {
        if (value === null || value === undefined) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify(value));
    } catch {
        // quota / blocked: the session continues in memory only
    }
}
