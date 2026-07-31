import type { BackoffOptions } from '@durable-streams/client';
import type { HttpClient } from '../http.ts';
import {
	assertConversationStreamChunk,
	type ConversationChunkPosition,
	type ConversationStreamChunk,
} from './conversation-stream.ts';
import {
	AUTH_FAILURE_LIMIT,
	comparePosition,
	retryBackoffMs,
	STALE_STREAM_TIMEOUT_MS,
	statusOf,
} from './follow-policy.ts';
import { createFlueEventStream } from './stream.ts';

export interface AgentWaitOptions {
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
	/**
	 * Invoked for each conversation stream chunk while waiting, for progress
	 * rendering. Each chunk is observed at most once: redelivered chunks
	 * (replays after a transport recovery) are skipped by position, and
	 * wire-only continuity markers are handled internally, never surfaced.
	 * Prefer `observe()` for maintained UI state.
	 */
	onEvent?: (event: ConversationStreamChunk) => void | Promise<void>;
}

/**
 * The minimal admission shape settlement-following needs: an offset-bearing
 * stream location and the submission id to watch for. `AgentSendResult`
 * satisfies this; so does `read()`'s internal re-attach target, which may
 * carry no `uid`.
 */
export interface AgentSettlementTarget {
	streamUrl: string;
	offset: string;
	submissionId: string;
}

export type FlueExecutionTarget = 'agent_submission';
export type FlueExecutionFailure = 'failed' | 'aborted' | 'terminal_event_missing';

export class FlueExecutionError extends Error {
	readonly target: FlueExecutionTarget;
	readonly targetId: string;
	readonly failure: FlueExecutionFailure;
	readonly error: unknown;

	constructor(options: {
		target: FlueExecutionTarget;
		targetId: string;
		failure: FlueExecutionFailure;
		error?: unknown;
	}) {
		super(executionErrorMessage(options));
		this.name = 'FlueExecutionError';
		this.target = options.target;
		this.targetId = options.targetId;
		this.failure = options.failure;
		this.error = options.error;
	}
}

/**
 * Follows the conversation `updates` stream until the target submission
 * settles. Shares `observe()`'s resilience policy (follow-policy.ts) with a
 * simpler recovery primitive: settlement scanning is pure and replay-safe —
 * a replayed or reset-folded settlement scans identically — so recovery
 * never needs a history snapshot; it just recreates the stream from the
 * admission offset (or the origin, once the admission offset is gone) and
 * re-scans.
 *
 * - Staleness: {@link STALE_STREAM_TIMEOUT_MS} with no delivered transport
 *   batch cancels the dead stream and recreates it, instead of waiting
 *   forever on a half-open connection.
 * - Transient auth: 401/403 retries with per-request re-resolved headers,
 *   bounded at {@link AUTH_FAILURE_LIMIT} consecutive failures with no
 *   intervening delivered chunk; the last auth error then rejects. 400 and
 *   every other status keep rejecting immediately.
 * - A `stream-checkpoint` chunk whose incarnation differs from the one this
 *   follow already saw means the stream was reset and regrown: recreate.
 * - A 416 (the admission offset is beyond the regrown stream's head)
 *   recreates from the origin `'-1'` — the documented re-attach offset.
 *
 * Settlement semantics are unchanged: a completed settlement resolves;
 * failed/aborted reject with {@link FlueExecutionError}.
 */
export async function waitForAgentSubmission(
	http: HttpClient,
	admission: AgentSettlementTarget,
	options: AgentWaitOptions = {},
): Promise<void> {
	const url = new URL(admission.streamUrl);
	url.searchParams.set('view', 'updates');

	// Every recovery recreates the stream from this offset. It starts at the
	// admission offset and is demoted to the origin '-1' permanently by a
	// 416: an offset the stream no longer has will not come back.
	let baseOffset = admission.offset;
	// Consecutive 401/403 failures since the last delivered chunk. See
	// {@link AUTH_FAILURE_LIMIT} for the reset rules.
	let authFailureStreak = 0;
	// Highest position delivered to this follow. Chunks at or below it are
	// redeliveries — recovery re-reads from the admission offset, and
	// at-least-once transports replay the in-flight batch on reconnect — and
	// are skipped so `onEvent` never observes a chunk twice. Cleared whenever
	// the stream generation changes (incarnation mismatch, 416): a regrown
	// stream restarts positions, and a stale high-water mark would silently
	// eat the new generation's chunks — including the settlement.
	let lastDelivered: ConversationChunkPosition | undefined;
	// Stream generation seen on this follow, learned from the first
	// `stream-checkpoint` chunk (unlike `observe()`, a settlement follow has
	// no history snapshot to learn it from).
	let observedIncarnation: string | undefined;

	while (true) {
		throwIfAborted(options.signal);
		// Set before this stream is torn down for recovery; `undefined` when
		// the loop below exits means the stream genuinely ended.
		let recovery: 'stale' | 'reset' | undefined;
		let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
		const stream = createFlueEventStream<ConversationStreamChunk>(
			{ offset: baseOffset, signal: options.signal, backoffOptions: options.backoffOptions },
			{
				url: url.toString(),
				fetch: http.fetchWithHeaders.bind(http),
				// Liveness seam: every transport batch — including empty
				// keep-alives that yield no chunk — re-arms the watchdog.
				onActivity: () => armWatchdog(),
			},
			assertConversationStreamChunk,
		);
		const armWatchdog = () => {
			if (watchdogTimer) clearTimeout(watchdogTimer);
			watchdogTimer = setTimeout(() => {
				watchdogTimer = undefined;
				recovery = 'stale';
				// Aborts the underlying connection: a live fetch rejects on
				// abort, so the `for await` below ends instead of blocking
				// forever on a half-open connection.
				stream.cancel();
			}, STALE_STREAM_TIMEOUT_MS);
		};
		armWatchdog();
		try {
			for await (const chunk of stream) {
				armWatchdog();
				throwIfAborted(options.signal);
				// Continuity markers are transport metadata, not content: never
				// part of the settlement scan, never surfaced to onEvent, never
				// progress. A changed incarnation means the stream was reset and
				// regrown under this follow — recreate and re-scan.
				if (chunk.type === 'stream-checkpoint') {
					if (observedIncarnation !== undefined && chunk.incarnation !== observedIncarnation) {
						observedIncarnation = chunk.incarnation;
						lastDelivered = undefined;
						recovery = 'reset';
						break;
					}
					observedIncarnation = chunk.incarnation;
					continue;
				}
				if (lastDelivered !== undefined && comparePosition(chunk.position, lastDelivered) <= 0) {
					continue;
				}
				lastDelivered = chunk.position;
				// A delivered chunk is real progress: refill the transient-auth
				// budget. Merely issuing a request must not, or a flapping
				// credential would retry forever.
				authFailureStreak = 0;
				await options.onEvent?.(chunk);
				throwIfAborted(options.signal);
				const settlement = settlementFromChunk(chunk, admission.submissionId);
				if (!settlement) continue;
				if (settlement.outcome === 'completed') return;
				throw new FlueExecutionError({
					target: 'agent_submission',
					targetId: admission.submissionId,
					failure: settlement.outcome === 'aborted' ? 'aborted' : 'failed',
					error: settlement.error,
				});
			}
		} catch (error) {
			// A watchdog-canceled stream may surface its teardown as an abort
			// error; that is part of the recovery, not a failure.
			if (recovery === undefined) {
				throwIfAborted(options.signal);
				if (error instanceof FlueExecutionError) throw error;
				const status = statusOf(error);
				if (status === 401 || status === 403) {
					// Bounded transient-auth retry: headers re-resolve per
					// request (async factories mint fresh tokens), so a
					// token-expiry race heals on the next attempt in ~1s.
					authFailureStreak++;
					if (authFailureStreak >= AUTH_FAILURE_LIMIT) throw error;
					await delay(retryBackoffMs(authFailureStreak - 1), options.signal);
				} else if (status === 416) {
					// The admission offset is beyond the (reset and regrown)
					// stream's head. Re-attach from the origin: the settlement
					// either exists in the new generation's replay, or the wait
					// legitimately continues.
					baseOffset = '-1';
					lastDelivered = undefined;
					observedIncarnation = undefined;
				} else {
					throw error;
				}
				continue;
			}
		} finally {
			if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
		}
		throwIfAborted(options.signal);
		if (recovery !== undefined) continue;
		// The server closed the stream without settling the submission.
		throw new FlueExecutionError({
			target: 'agent_submission',
			targetId: admission.submissionId,
			failure: 'terminal_event_missing',
		});
	}
}

/**
 * A submission's settlement appears as its own `submission-settled` chunk —
 * or folded into a `conversation-reset` snapshot, when a reset (for example a
 * compaction) landed in the same durable batch and subsumed it.
 */
function settlementFromChunk(
	chunk: ConversationStreamChunk,
	submissionId: string,
): { outcome: 'completed' | 'failed' | 'aborted'; error?: unknown } | undefined {
	if (chunk.type === 'submission-settled' && chunk.submissionId === submissionId) {
		return { outcome: chunk.outcome, ...(chunk.error === undefined ? {} : { error: chunk.error }) };
	}
	if (chunk.type === 'conversation-reset') {
		return chunk.snapshot.settlements.find((entry) => entry.submissionId === submissionId);
	}
	return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** Backoff sleep that ends early on abort (the caller re-checks the signal). */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function executionErrorMessage(options: {
	targetId: string;
	failure: FlueExecutionFailure;
	error?: unknown;
}): string {
	if (options.failure === 'terminal_event_missing') {
		return `Agent submission ${options.targetId} ended without a terminal event`;
	}
	const message = errorMessage(options.error);
	const verb = options.failure === 'aborted' ? 'was aborted' : 'failed';
	return `Agent submission ${options.targetId} ${verb}${message ? `: ${message}` : ''}`;
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === 'string') return error;
	if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
	return typeof error.message === 'string' ? error.message : undefined;
}
