import { runAsSystem } from "../tenancy/context";
import { DeveloperApp } from "./models";

/**
 * Browser origins registered by ACTIVE developer apps. Used only to extend CORS for the /v1 API and
 * Socket.IO (never credentials / cookies). A token from app A presented from app B's origin is
 * still rejected by verifyUserToken (each token is checked against its own app's allow-list).
 * Cached per process for 60 s; invalidated locally when apps change.
 */
const TTL_MS = 60_000;
let cache: { origins: Set<string>; at: number } | null = null;
let loading: Promise<Set<string>> | null = null;

export function forgetAppOrigins(): void {
    cache = null;
}

export async function appOrigins(): Promise<Set<string>> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.origins;
    if (!loading) {
        loading = runAsSystem(() => DeveloperApp.distinct("allowedOrigins", { status: "active" }), "app-origins")
            .then((list: string[]) => {
                const origins = new Set(list.filter((o) => typeof o === "string"));
                cache = { origins, at: Date.now() };
                return origins;
            })
            .finally(() => {
                loading = null;
            });
    }
    return loading;
}

export async function isAppOrigin(origin: string): Promise<boolean> {
    try {
        return (await appOrigins()).has(origin);
    } catch {
        return false;
    }
}
