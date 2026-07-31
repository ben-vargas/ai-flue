/**
 * Public-facing types for `@flue/vite`. Types that are part of the package's
 * public surface live here (or are re-exported from here when they naturally
 * belong next to an implementation), and `index.ts` re-exports them.
 *
 * This module must stay implementation-free: it is what the published
 * `index.d.mts` pulls in, so nothing here may import modules with runtime
 * side effects (in particular `virtual:flue/*`, which only resolves inside a
 * Vite graph running the flue() plugin).
 */

// ─── The Node build artifact's surface ──────────────────────────────────────
// `dist/app.mjs` exports `loadFlueNodeApplication`/`startFlueNodeServer`
// (implemented in bootstrap/node-server.ts); these are their parameter and
// return types. Hosts load the values from the artifact and take the types
// from `@flue/vite`.

export interface LoadFlueNodeApplicationOptions {
	/** Local (dev) mode: dev error rendering, dev SQLite file, lifecycle logs. */
	local?: boolean;
	/** Environment for the runtime; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/** An activity lease marking an in-flight request; release it when the request settles. */
export interface FlueNodeActivityLease {
	release(): void;
}

/** The loaded application's lifecycle surface (admission, drain, shutdown). */
export interface LoadedFlueNodeApplication {
	fetch(request: Request, env?: unknown): Response | Promise<Response>;
	/** Take an activity lease marking an in-flight request; `pauseAdmissions()` rejects new leases. */
	enterActivity(): FlueNodeActivityLease;
	/** Stop admitting new durable work (drain phase). */
	pauseAdmissions(): void;
	/** Graceful shutdown: coordinator, instrumentation, persistence. */
	stop(timeoutMs?: number): Promise<void>;
	/** Synchronous best-effort teardown for abnormal exits. */
	closeSync(): void;
}

export interface StartFlueNodeServerOptions extends LoadFlueNodeApplicationOptions {
	port?: number;
	hostname?: string;
	quiet?: boolean;
	signal?: AbortSignal;
	onReady?: () => void;
}

export interface FlueNodeServer {
	stop(): Promise<void>;
	closeSync(): void;
}
