import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CURSOR_PROVIDER_ROOT =
	process.env.PI_CURSOR_PROVIDER_ROOT ||
	join(AGENT_DIR, "git/github.com/ndraiman/pi-cursor-provider");

export const CURSOR_BASE = "cursor";

export function isCursorProviderId(id: string): boolean {
	return id === CURSOR_BASE || /^cursor-account-\d+$/.test(id);
}

/**
 * Whether the (separately cloned) Cursor provider is present on disk.
 *
 * `includeCursor` defaults to true, but the provider itself is an optional external
 * repo. Without this check the extension registered a `cursor-account-2` login slot
 * backed by nothing and warned about a `git clone` at every start — noise for the
 * majority of users who never asked for Cursor. Cheap enough (one existsSync) to call
 * on every discovery pass, and it picks up a later clone without a restart.
 */
export function isCursorProviderInstalled(): boolean {
	return existsSync(join(CURSOR_PROVIDER_ROOT, "cursor-shared.ts"));
}

type CursorShared = {
	ensureCursorProxy: (
		resolve: (providerId: string) => Promise<string>,
	) => Promise<number>;
	registerCursorProvider: (...args: any[]) => void;
	FALLBACK_MODELS: unknown[];
	/**
	 * Optional: read an account's real catalog. Older clones lack it — startup then
	 * keeps the fallback list until the next login/refresh, exactly as before.
	 */
	discoverCursorModels?: (accessToken: string) => Promise<unknown[]>;
};
type CursorIndex = { registerSessionLifecycleCleanup?: (pi: ExtensionAPI) => void };

let sharedModPromise: Promise<CursorShared | undefined> | undefined;
let indexMod: CursorIndex | undefined;
let proxyPort: number | undefined;
let loadAttempt = 0;

/**
 * A module that threw during evaluation stays cached as FAILED under its own URL, so a plain
 * re-import would replay the original error forever. Only the retry path pays for a fresh
 * instance, and only after the previous one proved unusable.
 */
function loadSpecifier(entry: string): string {
	return loadAttempt === 0
		? entry
		: `${pathToFileURL(entry).href}?pi-multi-account-retry=${loadAttempt}`;
}

/**
 * Cache the in-flight PROMISE, not the settled module.
 *
 * Discovery fires this without awaiting while `session_start` awaits its own call, so both
 * used to reach the import at once. A second concurrent import of the same module observes it
 * mid-initialization: hoisted functions are already callable while its `let` state is still in
 * the temporal dead zone, which surfaced as "Cannot access 'tokenResolver' before
 * initialization" and cost the session every Cursor account. One shared promise means the
 * module is imported exactly once, no matter how many callers race.
 */
async function loadCursorModules(): Promise<CursorShared | undefined> {
	sharedModPromise ??= (async () => {
		const entry = join(CURSOR_PROVIDER_ROOT, "cursor-shared.ts");
		if (!existsSync(entry)) return undefined;
		try {
			const shared = (await import(
				/* @vite-ignore */ loadSpecifier(entry)
			)) as CursorShared;
			const indexEntry = join(CURSOR_PROVIDER_ROOT, "index.ts");
			if (existsSync(indexEntry)) {
				indexMod = (await import(
					/* @vite-ignore */ loadSpecifier(indexEntry)
				)) as CursorIndex;
			}
			return shared;
		} catch (error) {
			// A failed import must not poison the cache forever: a user who fixes the clone
			// (or clones it at all) gets a fresh attempt on the next discovery pass.
			sharedModPromise = undefined;
			loadAttempt++;
			throw error;
		}
	})();
	return sharedModPromise;
}

type AuthEntry = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};

export async function setupCursorSubscription(
	pi: ExtensionAPI,
	options: {
		readAuth: () => Record<string, AuthEntry>;
		rejectDuplicateLogin?: (slot: string, creds: AuthEntry) => AuthEntry;
		slotIds: string[];
		notify?: (message: string, level: "info" | "warning") => void;
		/** Structured black-box logging; the host decides where it goes. */
		log?: (kind: string, data: Record<string, unknown>) => void;
	},
): Promise<number | undefined> {
	const mod = await loadCursorModules();
	if (!mod) {
		options.notify?.(
			`pi-multi-account: Cursor subscription support not found at ${CURSOR_PROVIDER_ROOT}. Run: git clone https://github.com/ndraiman/pi-cursor-provider ${CURSOR_PROVIDER_ROOT}`,
			"warning",
		);
		return undefined;
	}
	if (indexMod?.registerSessionLifecycleCleanup) {
		indexMod.registerSessionLifecycleCleanup(pi);
	}
	const resolveAccessToken = async (providerId: string) => {
		const entry = options.readAuth()[providerId];
		if (!entry || entry.type !== "oauth") return "";
		return typeof entry.access === "string" ? entry.access : "";
	};
	proxyPort = await mod.ensureCursorProxy(resolveAccessToken);
	const ids = [...new Set([CURSOR_BASE, ...options.slotIds])];
	for (const id of ids) {
		mod.registerCursorProvider(pi, id, proxyPort, mod.FALLBACK_MODELS, {
			rejectDuplicateLogin: options.rejectDuplicateLogin,
			onModelsDiscovered: (models: unknown[]) => {
				mod.registerCursorProvider(pi, id, proxyPort!, models as any[], {
					rejectDuplicateLogin: options.rejectDuplicateLogin,
				});
			},
		});
	}
	// Slots registered above start on FALLBACK_MODELS. A logged-in account would keep
	// that stale short list until its next token refresh — restart Pi and a catalog the
	// login already discovered is gone. Read it once here instead, from the first slot
	// whose stored token answers, and re-register every slot with it.
	void (async () => {
		if (typeof mod.discoverCursorModels !== "function") {
			options.log?.("cursor_catalog", { outcome: "unsupported" });
			return;
		}
		for (const id of ids) {
			const entry = options.readAuth()[id];
			if (!entry || entry.type !== "oauth" || !entry.access) continue;
			try {
				const models = await mod.discoverCursorModels(entry.access);
				if (!models?.length) {
					options.log?.("cursor_catalog", { outcome: "empty", provider: id });
					continue;
				}
				for (const slot of ids) {
					mod.registerCursorProvider(pi, slot, proxyPort!, models as any[], {
						rejectDuplicateLogin: options.rejectDuplicateLogin,
					});
				}
				options.log?.("cursor_catalog", { outcome: "discovered", provider: id, models: models.length });
				return;
			} catch (error) {
				options.log?.("cursor_catalog", {
					outcome: "error",
					provider: id,
					reason: error instanceof Error ? error.message : String(error),
				});
				// This account's token could not read the catalog — try the next one.
			}
		}
		options.log?.("cursor_catalog", { outcome: "unavailable", reason: "no slot could read the catalog" });
	})().catch((error) => {
		// Discovery is best-effort; the fallback catalog is already registered.
		options.log?.("cursor_catalog", {
			outcome: "crashed",
			reason: error instanceof Error ? error.message : String(error),
		});
	});
	return proxyPort;
}

export function getCursorProviderRoot(): string {
	return CURSOR_PROVIDER_ROOT;
}
