import { SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME } from '../adapter-helpers.ts';
import type { AgentSubmission, AgentSubmissionStore } from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import { ConversationRecordWriter } from '../conversation-writer.ts';
import {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	classifyError,
	InvalidRequestError,
	SubmissionAbortedError,
	SubmissionConflictError,
} from '../errors.ts';
import { interceptExecution } from '../execution-interceptor.ts';
import { createMcpConnectionCache } from '../mcp.ts';
import {
	type AttachedAgentSubmissionOptions,
	admitInstanceContact,
	adoptKeyedSubmissionReplay,
	type createAgentSubmissionSessionHandler,
	createDirectAgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	ensureInstanceIdentity,
	finalizePendingSettlement,
	type InstanceContactAdmission,
	type InstanceIdentity,
	isInstanceContactRejection,
	materializeSubmissionAttachments,
	processSubmission,
	reconcileInterruptedSubmission,
	serializeSubmissionError,
	settleUnclaimableSubmission,
	submissionSyntheticRequest,
	unreadySubmissionDeadline,
} from '../runtime/agent-submissions.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { type CoordinatorEventEmitter, createCoordinatorEventEmitter } from '../runtime/events.ts';
import { assertAgentDispatchAdmissionInput, handleAgentRequest } from '../runtime/handle-agent.ts';
import {
	handleAgentAttachmentRead,
	handleAgentConversationHead,
	handleAgentConversationRead,
} from '../runtime/handle-conversation-routes.ts';
import { generateAttemptId, isKeyDerivedSubmissionId } from '../runtime/ids.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import { createSessionStorageKey } from '../session-identity.ts';
import type { DeliveredMessage } from '../types.ts';
import {
	createSqlAgentExecutionStore,
	createSqlConversationStores,
} from './agent-execution-store.ts';

export const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';
export const CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH = '/__flue/internal/instance-info';

const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = '__flueWakeAgentSubmissions';
const FLUE_AGENT_SUBMISSION_WAKE_SECONDS = 30;
const FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER = 'flue:submission-attempt';
/**
 * Per-submission attempt cap within one drain. A settled fiber whose
 * submission is still unsettled (only reachable through SDK bugs or test
 * fakes — `processSubmission` settles durably on every real path) would
 * otherwise requeue-and-restart forever inside one alarm invocation. At the
 * cap the drain stops looping on that submission and defers it to the 30s
 * backstop, degrading to today's polling cadence instead of livelocking.
 */
const FLUE_AGENT_SUBMISSION_DRAIN_ATTEMPT_CAP = 3;

import type { SqlStorage } from '../sql-storage.ts';

interface CloudflareAgentStorage {
	sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

interface CloudflareAgentInstance {
	readonly name: string;
	readonly env: Record<string, unknown>;
	readonly ctx: {
		readonly id: { toString(): string };
		readonly storage: CloudflareAgentStorage;
	};
	schedule(
		delaySeconds: number,
		callback: string,
		payload: undefined,
		options: { idempotent: boolean },
	): Promise<unknown>;
	runFiber(
		name: string,
		callback: (ctx: { stash(snapshot: unknown): void }) => Promise<void>,
	): Promise<void>;
}

interface CloudflareAgentRecoveredFiberContext {
	readonly name?: string;
	readonly snapshot?: Record<string, unknown>;
}

/**
 * Handle for a started attempt. `running` is the guarded fiber promise
 * (never rejects; resolves after settlement AND cleanup). Wrapped in an
 * object so async plumbing can hand it around without the runtime flattening
 * a returned promise into an inline await of the whole attempt.
 */
interface StartedSubmissionAttempt {
	readonly running: Promise<void>;
}

interface CloudflareAgentPreparedCoordinator {
	readonly agentName: string;
	readonly submissionStore: AgentSubmissionStore;
	readonly conversationStreamStore: ConversationStreamStore;
	readonly attachmentStore: AttachmentStore;
}

interface CloudflareAgentRuntimeOptions {
	readonly agents: ReadonlyArray<{
		readonly name: string;
		readonly agent: Parameters<typeof createAgentSubmissionSessionHandler>[0];
	}>;
	readonly createContext: (options: {
		readonly submissionStore: AgentSubmissionStore;
		readonly instance: CloudflareAgentInstance;
		readonly agentName: string;
		readonly request: Request;
		readonly submissionId?: string;
	}) => FlueContextInternal;
	readonly runWithInstanceContext: <T>(
		instance: CloudflareAgentInstance,
		agentName: string,
		callback: () => T,
	) => T;
}

export interface CloudflareAgentRuntime {
	prepare(options: {
		readonly storage: CloudflareAgentStorage;
		readonly className: string;
		readonly agentName: string;
	}): CloudflareAgentPreparedCoordinator;
	attach(instance: CloudflareAgentInstance, prepared: CloudflareAgentPreparedCoordinator): void;
	onStart(
		instance: CloudflareAgentInstance,
		inherited: () => Promise<unknown> | unknown,
	): Promise<void>;
	/**
	 * The single place submission attempts start. Dispatched by the
	 * `__flueWakeAgentSubmissions` schedule target from inside the Durable
	 * Object's alarm invocation, and awaited there for the full duration of
	 * every attempt it starts — the alarm invocation owns the execution, so
	 * invocation-scoped platform observability (native tracing, log/outcome
	 * attribution) sees the agent's work. Every other boundary only records
	 * durable intent and arms this drain.
	 */
	drainSubmissions(instance: CloudflareAgentInstance): Promise<void>;
	onRequest(instance: CloudflareAgentInstance, request: Request): Promise<Response | null>;
	onFiberRecovered(
		instance: CloudflareAgentInstance,
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
	/**
	 * Run the Agents SDK alarm handler inside the instance context. Alarms
	 * dispatch `schedule`/`scheduleEvery`/`queue` callbacks to methods on the
	 * (possibly extension-authored) class, so this is the boundary that gives
	 * user scheduled callbacks `getCloudflareContext()` and
	 * `getDurableObjectIdentity()`.
	 */
	onAlarm(
		instance: CloudflareAgentInstance,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
}

export function createCloudflareAgentRuntime(
	options: CloudflareAgentRuntimeOptions,
): CloudflareAgentRuntime {
	const coordinators = new WeakMap<CloudflareAgentInstance, CloudflareAgentCoordinator>();

	const getCoordinator = (instance: CloudflareAgentInstance): CloudflareAgentCoordinator => {
		const coordinator = coordinators.get(instance);
		if (!coordinator) {
			throw new Error('[flue] Generated Cloudflare agent coordinator was not initialized.');
		}
		return coordinator;
	};

	return {
		prepare({ storage, className, agentName }) {
			const submissionStore = createSqlAgentExecutionStore(storage, className);
			const conversationStores = createSqlConversationStores(storage, className);
			return {
				agentName,
				submissionStore,
				...conversationStores,
			};
		},
		attach(instance, prepared) {
			coordinators.set(instance, new CloudflareAgentCoordinator(instance, prepared, options));
		},
		onStart(instance, inherited) {
			return getCoordinator(instance).onStart(inherited);
		},
		drainSubmissions(instance) {
			return getCoordinator(instance).drainSubmissions();
		},
		onRequest(instance, request) {
			return getCoordinator(instance).onRequest(request);
		},
		onFiberRecovered(instance, ctx, inherited) {
			return getCoordinator(instance).onFiberRecovered(ctx, inherited);
		},
		onAlarm(instance, inherited) {
			return getCoordinator(instance).onAlarm(inherited);
		},
	};
}

class CloudflareAgentCoordinator {
	constructor(
		private readonly instance: CloudflareAgentInstance,
		private readonly prepared: CloudflareAgentPreparedCoordinator,
		private readonly options: CloudflareAgentRuntimeOptions,
	) {
		this.emitCoordinatorEvent = createCoordinatorEventEmitter({
			agentName: prepared.agentName,
			instanceId: instance.name,
			env: instance.env,
		});
	}

	private conversationWriter: ConversationRecordWriter | undefined;
	private conversationWriterCreation: Promise<ConversationRecordWriter> | undefined;
	private conversationMaterialization: Promise<void> = Promise.resolve();
	/**
	 * Context-free live event emitter for coordinator signals
	 * (`submission_queued`, `submission_recovery`, recovered settlements) —
	 * independent of context/writer creation, which is among the failures it
	 * reports, and infallible by contract so it can never worsen a recovery
	 * catch block.
	 */
	private readonly emitCoordinatorEvent: CoordinatorEventEmitter;
	/**
	 * Live MCP connections for this instance (one DO = one agent instance).
	 * Submissions reuse them while the isolate stays warm; eviction is the
	 * teardown — a DO has no disposal hook, and streamable HTTP holds no
	 * server state worth a farewell.
	 */
	private readonly mcpConnections = createMcpConnectionCache();
	/**
	 * Abort controllers for in-flight attempt fibers in this isolate, keyed by
	 * submissionId, so an incoming cancel request can abort the running attempt.
	 * The DO is single-threaded but interleaves at `await` points, so a cancel
	 * request can set the controller while the fiber is suspended on provider
	 * I/O. If the isolate is evicted the controller is gone and the abort
	 * falls back to the durable `abortRequestedAt` + reconcile path.
	 */
	private activeControllers = new Map<string, AbortController>();

	// Instance context is established at exactly two boundaries: the public
	// coordinator entry points below (onStart/drainSubmissions/onRequest/
	// onFiberRecovered/onAlarm) and the durable submission fiber in
	// startSubmissionAttempt. These are the only ways execution enters the
	// Durable Object, and a recovered fiber resumes with no ambient context, so
	// each must (re)establish it. onAlarm wraps the Agents SDK alarm handler,
	// covering every scheduled callback it dispatches — including
	// extension-authored schedule/scheduleEvery/queue targets (#437); Flue's
	// own wake target still self-wraps via drainSubmissions, which simply
	// nests. Everything reachable from these boundaries — dispatch admission,
	// reconciliation, materialization, submission processing — assumes the
	// context is already present and never re-wraps.
	//
	// Execution ownership: attempts start ONLY inside drainSubmissions, which
	// runs as an alarm-dispatched schedule callback and awaits every attempt
	// it starts. All other boundaries (admission, abort, onStart,
	// onFiberRecovered) record durable intent and arm the drain. The SDK
	// deletes a one-shot schedule row only AFTER its callback returns, so an
	// armed drain row doubles as durable recovery: an isolate death mid-drain
	// leaves the row behind and the alarm re-fires on the fresh isolate.
	onStart(inherited: () => Promise<unknown> | unknown): Promise<void> {
		return this.runWithInstanceContext(async () => {
			// A fresh isolate has no live attempt by definition, so unsettled
			// work needs nothing beyond a drain: its reconcile pass classifies
			// interrupted attempts directly. Arm before the (possibly
			// extension-authored) inherited onStart — the durable driver must be
			// in place even if extension startup throws.
			await this.armDrainIfUnsettled();
			await inherited();
		});
	}

	/**
	 * In-isolate reentrancy guard. Alarm-dispatched drains are serialized by
	 * the platform (one `alarm()` at a time), but a direct call while a drain
	 * is live must not start a second loop: the active drain's next reconcile
	 * pass absorbs any work admitted meanwhile, and the caller's armed row
	 * fires a no-op drain afterwards.
	 */
	private draining = false;

	drainSubmissions(): Promise<void> {
		return this.runWithInstanceContext(() => this.drainLocked());
	}

	/**
	 * Drain loop: reconcile → start attempts → await them → repeat until a
	 * pass starts nothing. Errors below this method are either handled
	 * internally (reconcile logs and returns what it started; attempt
	 * promises are catch-guarded) or safe to propagate: the SDK retries a
	 * throwing schedule callback in-process and deliberately rethrows
	 * code-update resets so the preserved row re-runs on new code.
	 */
	private async drainLocked(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			if (!(await this.submissions.hasUnsettledSubmissions())) return;
			// Per-drain attempt counts backing the livelock cap; a fresh drain
			// (e.g. the 30s backstop) starts over.
			const attemptsBySubmission = new Map<string, number>();
			for (;;) {
				// The reconcile pass is storage-only and runs under the
				// `flue.coordinator` interception so tracing backends can group
				// its platform-instrumented storage spans. Attempt fibers start
				// AFTER the interception settles, deliberately: `runFiber` runs
				// its callback in the caller's async context, so a fiber started
				// inside the span's activation would re-parent its invoke_agent
				// span under the coordinator span. A claim whose start is
				// preempted here (crash, code-update reset) is an interrupted
				// attempt by construction — the next pass's running-recovery
				// loop reconciles it, and a durable abort in the widened
				// claim-to-start gap resolves through the existing
				// abortRequestedAt path.
				const claims = await interceptExecution(
					{ type: 'coordinator', phase: 'reconcile' },
					{ instanceId: this.instance.name, agentName: this.agentName },
					() => this.reconcileSubmissions(attemptsBySubmission),
				);
				const started: Array<Promise<void>> = [];
				for (const claimed of claims) {
					try {
						const attempt = await this.startGuardedAttempt(claimed, attemptsBySubmission);
						if (attempt) started.push(attempt.running);
					} catch (error) {
						this.logSubmissionReconciliationFailure(claimed, 'start_submission', error);
					}
				}
				if (started.length === 0) break;
				// Every promise is catch-guarded and finally-cleaned in
				// startSubmissionAttempt — this await cannot reject, and the
				// abort-controller cleanup completes before the next reconcile
				// pass observes the submission.
				await Promise.all(started);
			}
			// Anything still unsettled cannot progress locally right now
			// (deferred errors, capped submissions, work awaiting recovery
			// stamps): the 30s backstop owns it. Non-idempotent — an idempotent arm from inside
			// this callback could dedupe onto the row being executed, which the
			// SDK deletes after return, losing the wake.
			if (await this.submissions.hasUnsettledSubmissions()) {
				await this.armBackstop();
			}
		} finally {
			this.draining = false;
		}
	}

	onRequest(request: Request): Promise<Response | null> {
		return this.runWithInstanceContext(() => this.routeRequest(request));
	}

	async onAlarm(inherited: () => Promise<unknown> | unknown): Promise<unknown> {
		return this.runWithInstanceContext(() => inherited());
	}

	private async routeRequest(request: Request): Promise<Response | null> {
		if (isInternalDispatchRequest(request)) return this.admitDispatch(request);
		if (isInternalInstanceInfoRequest(request)) return this.instanceInfo();

		if (isAbortRequest(request, this.agentName, this.instance.name)) {
			const aborted = await this.abortInstance();
			return Response.json({ aborted });
		}

		const method = request.method;
		if (method === 'GET' || method === 'HEAD') {
			const streamPath = agentStreamPath(this.agentName, this.instance.name);
			// Attachment byte download. The outer Worker has already run the
			// module's `route` middleware, only forwards GET, and rewrites the
			// request onto the canonical `/agents/<name>/<id>/attachments/<id>`
			// path whatever the public mount looks like — so the DO, which owns
			// the bytes, just serves from its attachment store. Match the exact
			// tail (not a loose `/attachments/` substring) so an agent literally
			// named "attachments" doesn't misroute its conversation reads here.
			const segments = new URL(request.url).pathname.split('/');
			const attachmentId =
				method === 'GET' &&
				segments.length >= 4 &&
				segments[segments.length - 2] === 'attachments' &&
				segments[segments.length - 3] === this.instance.name &&
				segments[segments.length - 4] === this.agentName
					? decodeURIComponent(segments[segments.length - 1] as string)
					: undefined;
			if (attachmentId) {
				return handleAgentAttachmentRead({
					conversationStore: this.prepared.conversationStreamStore,
					attachmentStore: this.prepared.attachmentStore,
					path: streamPath,
					attachmentId: decodeURIComponent(attachmentId),
				});
			}
			if (method === 'HEAD') {
				return await handleAgentConversationHead(this.prepared.conversationStreamStore, streamPath);
			}
			return handleAgentConversationRead({
				store: this.prepared.conversationStreamStore,
				path: streamPath,
				request,
			});
		}

		return handleAgentRequest({
			request,
			id: this.instance.name,
			agentName: this.agentName,
			admitAttachedSubmission: (message, options) => this.admitAttachedSubmission(message, options),
		});
	}

	/**
	 * The SDK detected one of our attempt fibers interrupted (crash replay on
	 * a fresh isolate, or a survived run row after a reset). The durable
	 * submission row already carries everything recovery needs — the drain's
	 * reconcile pass classifies it — so the only job here is ensuring a drain
	 * runs. Resolving (not throwing) tells the SDK the recovery is handled,
	 * which deletes its run row.
	 */
	onFiberRecovered(
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> {
		return this.runWithInstanceContext(async () => {
			if (ctx.name !== FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER) return inherited();
			await this.armDrain();
		});
	}

	private get agentName(): string {
		return this.prepared.agentName;
	}

	private get submissions(): AgentSubmissionStore {
		return this.prepared.submissionStore;
	}

	private runWithInstanceContext<T>(callback: () => T): T {
		return this.options.runWithInstanceContext(this.instance, this.agentName, callback);
	}

	private async ensureConversationWriter(): Promise<ConversationRecordWriter> {
		if (this.conversationWriter && !this.conversationWriter.failed) return this.conversationWriter;
		if (!this.conversationWriterCreation) {
			const creation = ConversationRecordWriter.create({
				store: this.prepared.conversationStreamStore,
				path: agentStreamPath(this.agentName, this.instance.name),
				identity: { agentName: this.agentName, instanceId: this.instance.name },
				producerId: this.instance.ctx.id.toString(),
				onFailed: (writer) => {
					if (this.conversationWriter === writer) this.conversationWriter = undefined;
				},
			});
			this.conversationWriterCreation = creation;
			void creation.then(
				(writer) => {
					if (!writer.failed) this.conversationWriter = writer;
					if (this.conversationWriterCreation === creation)
						this.conversationWriterCreation = undefined;
				},
				() => {
					if (this.conversationWriterCreation === creation)
						this.conversationWriterCreation = undefined;
				},
			);
		}
		return this.conversationWriterCreation;
	}

	private createContext(request: Request, submissionId?: string): FlueContextInternal {
		return this.options.createContext({
			submissionStore: this.submissions,
			instance: this.instance,
			agentName: this.agentName,
			request,
			submissionId,
		});
	}

	private createDurableContext(request: Request, submissionId?: string): FlueContextInternal {
		const ctx = this.createContext(request, submissionId);
		ctx.setConversationWriter?.(this.conversationWriter);
		ctx.setAttachmentStore?.(this.prepared.attachmentStore);
		ctx.setMcpConnections?.(this.mcpConnections);
		return ctx;
	}

	private assertAgentsDurabilityApi(method: 'runFiber' | 'schedule'): void {
		if (typeof this.instance[method] !== 'function') {
			throw new Error(
				`[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "${method}". Install or upgrade the "agents" package in your project.`,
			);
		}
	}

	/**
	 * Arm a zero-delay drain. Always non-idempotent: an idempotent arm can
	 * dedupe onto a drain row that is currently executing — the SDK keeps the
	 * row in `cf_agents_schedules` until its callback returns, then deletes
	 * it — so an admission landing in the tail of a running drain would lose
	 * its wake entirely. A fresh row per arm closes that race; extra rows
	 * fire cheap no-op drains.
	 */
	private armDrain(): Promise<unknown> {
		this.assertAgentsDurabilityApi('schedule');
		return this.instance.schedule(0, FLUE_AGENT_SUBMISSION_WAKE_CALLBACK, undefined, {
			idempotent: false,
		});
	}

	/** 30s backstop wake onto the same schedule target (see armDrain for why non-idempotent). */
	private armBackstop(): Promise<unknown> {
		this.assertAgentsDurabilityApi('schedule');
		return this.instance.schedule(
			FLUE_AGENT_SUBMISSION_WAKE_SECONDS,
			FLUE_AGENT_SUBMISSION_WAKE_CALLBACK,
			undefined,
			{ idempotent: false },
		);
	}

	private async armDrainIfUnsettled(): Promise<boolean> {
		if (!(await this.submissions.hasUnsettledSubmissions())) return false;
		await this.armDrain();
		return true;
	}

	/**
	 * One reconcile pass: materialize unready submissions, finalize pending
	 * settlements, recover interrupted attempts, claim and START runnable
	 * work. Returns the started attempts' guarded fiber promises for the
	 * drain to await — this method never waits on agent execution itself.
	 * Failures are logged with `deferred_to_scheduled_wake` and surface as
	 * still-unsettled work the drain hands to the backstop.
	 */
	private async reconcileSubmissions(
		attemptsBySubmission: Map<string, number>,
	): Promise<ReadonlyArray<AgentSubmission>> {
		const toStart: Array<AgentSubmission> = [];
		if (!(await this.submissions.hasUnsettledSubmissions())) return toStart;
		try {
			for (const submission of await this.submissions.listUnreadySubmissions()) {
				// A durable abort on an unready row settles here: the row is never
				// claimable, so the attempt-based abort settle can never run — this
				// is the guaranteed escape hatch for every stuck-unready class.
				if (submission.abortRequestedAt !== undefined) {
					await settleUnclaimableSubmission(
						this.submissions,
						submission,
						'aborted',
						new SubmissionAbortedError(),
						this.emitCoordinatorEvent,
					);
					continue;
				}
				const found = this.options.agents.find(
					(record) => record.name === submission.input.agent,
				)?.agent;
				const agent =
					found &&
					submission.input.agent === this.agentName &&
					submission.input.id === this.instance.name
						? found
						: undefined;
				if (!agent) {
					if (
						Date.now() >= unreadySubmissionDeadline(submission, undefined) &&
						(await this.terminalizeUnreadySubmission(
							submission,
							new Error(
								`[flue] Submission target agent "${submission.input.agent}" has no registered definition, so the submission could never start.`,
							),
						))
					) {
						continue;
					}
					console.error('[flue:submission-reconciliation]', {
						agentName: this.agentName,
						instanceId: this.instance.name,
						submissionId: submission.submissionId,
						sessionKey: submission.sessionKey,
						operation: 'materialize_submission',
						outcome: 'agent_unavailable',
					});
					this.emitCoordinatorEvent({
						type: 'submission_recovery',
						submissionId: submission.submissionId,
						kind: submission.kind,
						operation: 'materialize_submission',
						outcome: 'agent_unavailable',
					});
					continue;
				}
				try {
					await this.materializeSubmissionConversation(submission.input, agent);
					await this.submissions.markSubmissionCanonicalReady(submission.submissionId);
				} catch (error) {
					if (
						Date.now() >= unreadySubmissionDeadline(submission, agent) &&
						(await this.terminalizeUnreadySubmission(submission, error))
					) {
						continue;
					}
					this.logSubmissionReconciliationFailure(submission, 'materialize_submission', error);
				}
			}
			for (const settlement of await this.submissions.listPendingSubmissionSettlements()) {
				const submission = await this.submissions.getSubmission(settlement.submissionId);
				if (!submission) continue;
				// Per-item isolation, matching the sibling loops: one bad settlement
				// (e.g. a canonical mismatch) must not skip the running-recovery and
				// runnable-claim passes below for the instance's other work.
				try {
					const writer = await this.ensureConversationWriter();
					await finalizePendingSettlement(
						this.submissions,
						writer,
						settlement,
						this.emitCoordinatorEvent,
					);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, 'finalize_settlement', error);
				}
			}
			for (const submission of await this.submissions.listRunningSubmissions()) {
				// A running submission reaching this loop is an interrupted attempt
				// by construction: attempts only run inside a drain, drains are
				// serialized (platform alarm ordering + the per-coordinator
				// draining guard), every attempt this drain started has been
				// awaited to cleanup before this pass, and a coordinator
				// replacement (code-update reset / fresh isolate) implies the
				// prior drain's fibers are dead. A hypothetical zombie is fenced
				// by the claim CAS and attempt-id ownership checks on every
				// durable write.
				try {
					const replacement = await this.reconcileInterruptedSubmission(submission);
					// The attempt fiber starts after the reconcile pass returns —
					// see drainLocked for why starts must escape the pass's
					// tracing activation.
					if (replacement) toStart.push(replacement);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, 'reconcile_submission', error);
				}
			}
			for (const submission of await this.submissions.listRunnableSubmissions()) {
				if (this.drainAttemptCapReached(submission, attemptsBySubmission)) continue;
				// Cloudflare DOs are single-threaded per instance — leases are
				// advisory-only. Set to 0 so reconciliation never misidentifies
				// an active submission as expired. The Node coordinator uses real
				// lease expiry with heartbeat renewal for multi-process safety.
				const claimed = await this.submissions.claimSubmission({
					submissionId: submission.submissionId,
					attemptId: generateAttemptId(),
					ownerId: this.instance.ctx.id.toString(),
					leaseExpiresAt: 0,
				});
				if (claimed) toStart.push(claimed);
			}
		} catch (error) {
			console.error(
				'[flue:submission-reconciliation]',
				{
					agentName: this.agentName,
					instanceId: this.instance.name,
					operation: 'reconcile',
					outcome: 'deferred_to_scheduled_wake',
				},
				error,
			);
			this.emitCoordinatorEvent(
				{
					type: 'submission_recovery',
					operation: 'reconcile_pass',
					outcome: 'deferred',
					error: serializeSubmissionError(error),
				},
				{ errorInfo: classifyError(error) },
			);
		}
		return toStart;
	}

	private drainAttemptCapReached(
		submission: AgentSubmission,
		attemptsBySubmission: Map<string, number>,
	): boolean {
		if (
			(attemptsBySubmission.get(submission.submissionId) ?? 0) <
			FLUE_AGENT_SUBMISSION_DRAIN_ATTEMPT_CAP
		) {
			return false;
		}
		console.error('[flue:submission-reconciliation]', {
			agentName: this.agentName,
			instanceId: this.instance.name,
			submissionId: submission.submissionId,
			operation: 'start_submission',
			outcome: 'drain_attempt_cap_deferred_to_scheduled_wake',
		});
		this.emitCoordinatorEvent({
			type: 'submission_recovery',
			submissionId: submission.submissionId,
			kind: submission.kind,
			operation: 'start_submission',
			outcome: 'attempt_cap_deferred',
			attemptCount: submission.attemptCount,
			maxAttempts: submission.maxAttempts,
		});
		return true;
	}

	/**
	 * Count the attempt against the per-drain cap and start it. The cap check
	 * here (in addition to the pre-claim check in the runnable loop) covers
	 * interrupted-recovery replacements, which arrive already claimed.
	 */
	private async startGuardedAttempt(
		submission: AgentSubmission,
		attemptsBySubmission: Map<string, number>,
	): Promise<StartedSubmissionAttempt | undefined> {
		if (this.drainAttemptCapReached(submission, attemptsBySubmission)) return undefined;
		attemptsBySubmission.set(
			submission.submissionId,
			(attemptsBySubmission.get(submission.submissionId) ?? 0) + 1,
		);
		return this.startSubmissionAttempt(submission);
	}

	/**
	 * Auto-fail a queued row whose materialization can never succeed, past its
	 * admission-anchored durability bound (see `unreadySubmissionDeadline`).
	 * Returns whether this coordinator won the terminal transition — a `false`
	 * (another isolate settled first, or a racing claim made the row runnable)
	 * falls back to the deferral logging so nothing is silently dropped.
	 */
	private async terminalizeUnreadySubmission(
		submission: AgentSubmission,
		error: unknown,
	): Promise<boolean> {
		const settled = await settleUnclaimableSubmission(
			this.submissions,
			submission,
			'failed',
			error,
			this.emitCoordinatorEvent,
		);
		if (!settled) return false;
		console.error(
			'[flue:submission-reconciliation]',
			{
				agentName: this.agentName,
				instanceId: this.instance.name,
				submissionId: submission.submissionId,
				sessionKey: submission.sessionKey,
				operation: 'materialize_submission',
				outcome: 'terminated',
			},
			error,
		);
		return true;
	}

	private logSubmissionReconciliationFailure(
		submission: AgentSubmission,
		operation:
			| 'materialize_submission'
			| 'finalize_settlement'
			| 'reconcile_submission'
			| 'start_submission',
		error: unknown,
	): void {
		console.error(
			'[flue:submission-reconciliation]',
			{
				agentName: this.agentName,
				instanceId: this.instance.name,
				submissionId: submission.submissionId,
				sessionKey: submission.sessionKey,
				attemptId: submission.attemptId,
				operation,
				outcome: 'deferred_to_scheduled_wake',
			},
			error,
		);
		this.emitCoordinatorEvent(
			{
				type: 'submission_recovery',
				submissionId: submission.submissionId,
				kind: submission.kind,
				operation,
				outcome: 'deferred',
				attemptCount: submission.attemptCount,
				maxAttempts: submission.maxAttempts,
				error: serializeSubmissionError(error),
			},
			{ errorInfo: classifyError(error) },
		);
	}

	/**
	 * Recover one interrupted attempt. Returns the claimed replacement
	 * submission (if recovery produced one) for the caller's reconcile pass
	 * to start — attempts start only through the drain's guarded path.
	 */
	private async reconcileInterruptedSubmission(
		submission: AgentSubmission,
	): Promise<AgentSubmission | undefined> {
		const conversationWriter = await this.ensureConversationWriter();
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.agent;
		if (!agent) throw new Error('[flue] Agent target unavailable during durable reconciliation.');
		const replacement = await reconcileInterruptedSubmission(
			this.submissions,
			submission,
			agent,
			(submissionId) =>
				this.createDurableContext(submissionSyntheticRequest(submission.input), submissionId),
			{ ownerId: this.instance.ctx.id.toString(), leaseExpiresAt: 0 },
			conversationWriter,
			this.emitCoordinatorEvent,
		);
		return replacement ?? undefined;
	}

	/**
	 * Start one attempt fiber and return a handle carrying its guarded
	 * promise for the drain to await. The promise never rejects (failures
	 * settle durably in processSubmission and are logged here) and resolves
	 * only after the abort-controller cleanup, so the drain's next reconcile
	 * pass observes consistent state.
	 * The handle object exists because returning the promise directly from
	 * this async method would flatten it: callers would await the whole
	 * attempt instead of receiving something awaitable.
	 */
	private async startSubmissionAttempt(
		submission: AgentSubmission,
	): Promise<StartedSubmissionAttempt | undefined> {
		if (submission.status !== 'running' || !submission.attemptId) return undefined;
		this.assertAgentsDurabilityApi('runFiber');
		const controller = new AbortController();
		this.activeControllers.set(submission.submissionId, controller);
		let running: Promise<void>;
		try {
			running = this.instance.runFiber(FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER, async (fiberCtx) => {
				fiberCtx.stash({ submissionId: submission.submissionId, attemptId: submission.attemptId });
				// The fiber is the second context boundary: it may resume on a
				// fresh isolate (via the SDK's crash replay) with no ambient
				// context, so it establishes its own.
				await this.runWithInstanceContext(() =>
					this.processSubmissionEntry(submission, controller.signal),
				);
			});
		} catch (error) {
			this.deleteControllerIfCurrent(submission.submissionId, controller);
			throw error;
		}
		return {
			running: running
				.catch((error) => {
					console.error(
						'[flue:submission-processing]',
						{
							agentName: this.agentName,
							instanceId: this.instance.name,
							submissionId: submission.submissionId,
							operation: 'process',
							outcome: 'failed',
						},
						error,
					);
					// Usually post-settlement (processSubmission settles failed
					// durably and emits the live submission_settled before
					// rethrowing); when the failure struck settlement itself the
					// row is still unsettled and the backstop owns it.
					this.emitCoordinatorEvent(
						{
							type: 'submission_recovery',
							submissionId: submission.submissionId,
							kind: submission.kind,
							operation: 'process_submission',
							outcome: 'deferred',
							error: serializeSubmissionError(error),
						},
						{ errorInfo: classifyError(error) },
					);
				})
				.finally(() => {
					this.deleteControllerIfCurrent(submission.submissionId, controller);
				}),
		};
	}

	/**
	 * Controllers are keyed by submissionId and shared across attempts, so a
	 * late cleanup from a superseded attempt (its fiber promise settling after
	 * a replacement attempt already registered its own controller) must not
	 * delete the replacement's controller — that would sever the abort path
	 * for a live attempt.
	 */
	private deleteControllerIfCurrent(submissionId: string, controller: AbortController): void {
		if (this.activeControllers.get(submissionId) === controller) {
			this.activeControllers.delete(submissionId);
		}
	}

	async abortInstance(): Promise<boolean> {
		// One DO instance owns one agent instance; external submissions share one
		// durable session, so a single session-scoped stamp covers the running
		// head and every queued submission behind it.
		const sessionKey = createSessionStorageKey(
			this.agentName,
			this.instance.name,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		);
		const affected = await this.submissions.requestSessionAbort(sessionKey);
		if (affected.length === 0) return false;
		// Abort any of those attempt fibers live in this isolate — processSubmission's
		// catch settles them aborted, and the drain awaiting the fiber observes the
		// settlement. Queued ones settle via the pre-execution abort check once the
		// drain claims them; an evicted running attempt is driven by the durable
		// flag through the drain's reconciliation.
		for (const submissionId of affected) {
			this.activeControllers.get(submissionId)?.abort(new SubmissionAbortedError());
		}
		await this.armDrain();
		return true;
	}

	/**
	 * Admission-side materialization, serialized per instance: ensure the
	 * birth record (find-or-create, no render, no sandbox) and persist the
	 * message's attachments under its conversation id. Idempotent — admission,
	 * replays, and the unready-row recovery pass all run it safely. Returns
	 * the identity for the receipt.
	 */
	private materializeSubmissionConversation(
		input: AgentSubmission['input'],
		agent: Parameters<typeof createAgentSubmissionSessionHandler>[0],
	): Promise<InstanceIdentity> {
		const operation = this.conversationMaterialization.then(async () => {
			const writer = await this.ensureConversationWriter();
			const identity = await ensureInstanceIdentity(writer, agent, input.initialData);
			await materializeSubmissionAttachments(
				input,
				identity.conversationId,
				this.prepared.attachmentStore,
			);
			return identity;
		});
		this.conversationMaterialization = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	private async processSubmissionEntry(
		submission: AgentSubmission,
		signal?: AbortSignal,
	): Promise<void> {
		const conversationWriter = await this.ensureConversationWriter();
		await processSubmission({
			submissions: this.submissions,
			submission,
			resolveAgent: (name) => {
				const agent = this.options.agents.find((record) => record.name === name)?.agent;
				if (!agent) throw new Error('[flue] Agent target unavailable during durable processing.');
				return agent;
			},
			createContext: (submissionId) =>
				this.createDurableContext(submissionSyntheticRequest(submission.input), submissionId),
			conversationWriter,
			emitCoordinatorEvent: this.emitCoordinatorEvent,
			signal,
		});
	}

	private async admitAttachedSubmission(
		message: DeliveredMessage,
		options: AttachedAgentSubmissionOptions = {},
	) {
		const { traceCarrier, initialData, uid, idempotencyKey } = options;
		const input = await createDirectAgentSubmissionInput({
			agent: this.agentName,
			id: this.instance.name,
			message,
			initialData,
			traceCarrier,
			...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
		});
		const keyed = idempotencyKey !== undefined;
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.agent;
		if (!agent) throw new Error('[flue] Agent target unavailable during durable admission.');
		const loadReducedState = async () => (await this.ensureConversationWriter()).loadReducedState();
		// A deduplicated replay re-attaches from the stream origin: the original
		// admission-time offset is not persisted, and settlement records are
		// observable from the origin indefinitely.
		const adoptedReceipt = async (submissionId: string) => {
			const reducedUid = (await loadReducedState()).uid;
			if (reducedUid === undefined) return undefined;
			await this.armDrain();
			return {
				submissionId,
				offset: '-1',
				uid: reducedUid,
				deduplicated: true as const,
			};
		};
		let contact: InstanceContactAdmission;
		try {
			contact = await admitInstanceContact({
				agent,
				id: this.instance.name,
				initialData,
				uid,
				loadReducedState,
			});
		} catch (error) {
			// Keyed retries can trip their own send condition (a create-only send
			// whose first attempt created the instance): adopt the submission the
			// key already names — the condition was consumed by the original
			// admission. A fresh keyed send keeps today's exact semantics.
			if (keyed && isInstanceContactRejection(error)) {
				const adopted = await adoptKeyedSubmissionReplay(this.submissions, input);
				const receipt = adopted && (await adoptedReceipt(adopted.submissionId));
				if (receipt) return receipt;
			}
			throw error;
		}
		let admitted: AgentSubmission;
		let deduplicated = false;
		try {
			admitted = await this.submissions.admitDirect(input);
		} catch (error) {
			// The store rejects a caller retry byte-exactly (it re-stamps
			// acceptedAt/traceCarrier); a keyed admission converges on identity
			// above the store instead. Adoption only ever swallows the failure
			// when a matching-identity row exists.
			if (!keyed) throw error;
			const adopted = await adoptKeyedSubmissionReplay(this.submissions, input);
			if (!adopted) throw error;
			admitted = adopted;
			deduplicated = true;
		}
		// Live queue signal, emitted immediately after durable admission.
		// At-least-once: admission cannot distinguish an idempotent replay, so
		// replays (keyed dedup included) re-emit.
		this.emitCoordinatorEvent({
			type: 'submission_queued',
			submissionId: admitted.submissionId,
			kind: 'direct',
		});
		// The durable row exists from here on: the drain must be armed even if
		// materialization/readiness/uid below throws, or the queued row would
		// strand with nothing to ever claim it.
		try {
			let identity: InstanceIdentity | undefined;
			if (admitted.canonicalReadyAt === null) {
				identity = await this.materializeSubmissionConversation(input, agent);
				// Tolerate a null return: a concurrent readiness pass may have
				// advanced this row already; null means "already past queued", not
				// a lost submission (rows are never deleted).
				await this.submissions.markSubmissionCanonicalReady(input.submissionId);
			}
			const writer = await this.ensureConversationWriter();
			const offset = deduplicated ? '-1' : writer.offset;
			// An adopted replay may hold neither the contact uid nor a fresh
			// identity (its gate ran before the winning admission materialized) —
			// the birth record is durable by then, so read the identity back.
			let instanceUid = contact.uid ?? identity?.uid;
			if (instanceUid === undefined && deduplicated) {
				instanceUid = (await loadReducedState()).uid;
			}
			if (instanceUid === undefined) {
				throw new Error(
					"[flue] invariant: a materialized instance's birth record must carry a uid.",
				);
			}
			return {
				submissionId: input.submissionId,
				offset,
				uid: instanceUid,
				...(deduplicated ? { deduplicated: true as const } : {}),
			};
		} finally {
			await this.armDrain();
		}
	}

	/**
	 * Internal instance lookup for `getAgentInstance()`: existence and uid
	 * from this Durable Object's reduced conversation state. Getting a DO
	 * stub implicitly instantiates the object, so existence is judged by the
	 * birth record, never by DO liveness.
	 */
	private async instanceInfo(): Promise<Response> {
		const reduced = await (await this.ensureConversationWriter()).loadReducedState();
		if (reduced.initialData === undefined) return Response.json({ exists: false });
		return Response.json({
			exists: true,
			...(reduced.uid !== undefined ? { uid: reduced.uid } : {}),
		});
	}

	private async admitDispatch(request: Request): Promise<Response> {
		const input: unknown = await request.json();
		assertAgentDispatchAdmissionInput(input);
		if (input.agent !== this.agentName || input.id !== this.instance.name) {
			return new Response('Invalid internal dispatch target.', { status: 400 });
		}
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.agent;
		if (!agent) return new Response('Dispatch target unavailable.', { status: 404 });
		const keyed = isKeyDerivedSubmissionId(input.submissionId);
		const submissionInput = createDispatchAgentSubmissionInput(input);
		const loadReducedState = async () => (await this.ensureConversationWriter()).loadReducedState();
		try {
			let contact: InstanceContactAdmission;
			try {
				contact = await admitInstanceContact({
					agent,
					id: this.instance.name,
					initialData: input.initialData,
					uid: input.uid,
					loadReducedState,
				});
			} catch (error) {
				// Keyed retries can trip their own send condition (a create-only
				// send whose first attempt created the instance): adopt the
				// submission the key already names — the condition was consumed by
				// the original admission — and echo the recorded uid. A fresh
				// keyed send keeps today's exact semantics.
				if (keyed && isInstanceContactRejection(error)) {
					const adopted = await adoptKeyedSubmissionReplay(this.submissions, submissionInput);
					const adoptedUid = adopted ? (await loadReducedState()).uid : undefined;
					if (adopted && adoptedUid !== undefined) {
						await this.armDrain();
						return Response.json({
							submissionId: adopted.submissionId,
							acceptedAt: adopted.input.acceptedAt,
							uid: adoptedUid,
							deduplicated: true,
						});
					}
				}
				throw error;
			}
			const admission = await this.submissions.admitDispatch(input);
			let submission: AgentSubmission;
			let deduplicated = false;
			if (admission.kind === 'submission') {
				submission = admission.submission;
			} else {
				// The store rejects a caller retry byte-exactly (it re-stamps
				// acceptedAt); a keyed conflict converges on submission identity
				// above the store. Everything else — unkeyed conflicts and keyed
				// divergence — is the structured 409 the Worker side rehydrates.
				const adopted = keyed
					? await adoptKeyedSubmissionReplay(this.submissions, submissionInput)
					: undefined;
				if (!adopted) throw new SubmissionConflictError({ submissionId: input.submissionId });
				submission = adopted;
				deduplicated = true;
			}
			// Live queue signal, emitted immediately after durable admission.
			// At-least-once: admission cannot distinguish an idempotent replay,
			// so replays (keyed dedup included) re-emit.
			this.emitCoordinatorEvent({
				type: 'submission_queued',
				submissionId: submission.submissionId,
				kind: 'dispatch',
			});
			// The durable row exists from here on: the drain must be armed even if
			// materialization/readiness/uid below throws, or the queued row would
			// strand with nothing to ever claim it.
			try {
				let identity: InstanceIdentity | undefined;
				if (submission.canonicalReadyAt === null) {
					identity = await this.materializeSubmissionConversation(submissionInput, agent);
					// Tolerate a null return (see the direct path): a concurrent readiness
					// pass may have advanced this row already; null is not a lost submission.
					await this.submissions.markSubmissionCanonicalReady(input.submissionId);
				}
				// The uid rides every receipt: echoed for a continuing send, minted by
				// materialization's identity ensure for a creating one. An adopted
				// replay may hold neither (its gate ran before the winning admission
				// materialized) — read the recorded identity back instead.
				let uid = contact.uid ?? identity?.uid;
				if (uid === undefined && deduplicated) uid = (await loadReducedState()).uid;
				if (uid === undefined) {
					throw new Error(
						"[flue] invariant: a materialized instance's birth record must carry a uid.",
					);
				}
				return Response.json({
					submissionId: submission.submissionId,
					// The stored row's timestamp, so a deduplicated replay echoes the
					// ORIGINAL admission's receipt (identical on a fresh admission).
					acceptedAt: submission.input.acceptedAt,
					uid,
					...(deduplicated ? { deduplicated: true } : {}),
				});
			} finally {
				await this.armDrain();
			}
		} catch (error) {
			// Structured body so the dispatch() caller's enqueue can rehydrate the
			// typed admission error (`type` selects the class; `uid` restores the
			// instance-exists 409's incarnation field; `submissionId` restores the
			// submission-conflict 409's existing id) with caller-safe details intact.
			if (
				error instanceof InvalidRequestError ||
				error instanceof AgentInstanceNotFoundError ||
				error instanceof AgentInstanceExistsError ||
				error instanceof SubmissionConflictError
			) {
				return Response.json(
					{
						type: error.type,
						error: error.message,
						details: error.details,
						...(error instanceof AgentInstanceExistsError ? { uid: error.uid } : {}),
						...(error instanceof SubmissionConflictError
							? { submissionId: error.submissionId }
							: {}),
					},
					{ status: error.status },
				);
			}
			throw error;
		}
	}
}

function isInternalDispatchRequest(request: Request): boolean {
	return (
		request.method === 'POST' &&
		new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH
	);
}

function isInternalInstanceInfoRequest(request: Request): boolean {
	return (
		request.method === 'GET' &&
		new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH
	);
}

/**
 * Whether the request is an abort for this agent instance
 * (`POST .../agents/<name>/<id>/abort`). Matched by exact tail position (not a
 * loose substring) so an agent or instance named "abort" cannot misroute.
 */
function isAbortRequest(request: Request, agentName: string, instanceName: string): boolean {
	if (request.method !== 'POST') return false;
	const segments = new URL(request.url).pathname.split('/');
	const n = segments.length;
	if (n < 4) return false;
	return (
		segments[n - 1] === 'abort' &&
		decodeURIComponent(segments[n - 2] as string) === instanceName &&
		decodeURIComponent(segments[n - 3] as string) === agentName
	);
}
