import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent-definition.ts';
import { Harness } from '../src/harness.ts';
import { dispatch, observe } from '../src/index.ts';
import {
	configureFlueRuntime,
	createAgentDispatchProcessor,
	createFlueContext,
	type DispatchInput,
	InMemoryDispatchQueue,
	InMemorySessionStore,
	resetFlueRuntimeForTests,
} from '../src/internal.ts';
import type { AgentConfig, FlueHarness, FlueSession } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('dispatch()', () => {
	it('rejects calls when the runtime has not been configured', async () => {
		await expect(
			dispatch({ agent: 'moderator', id: 'guild:unconfigured', input: { type: 'flagged' } }),
		).rejects.toThrow('dispatch() called before runtime was configured');
	});

	it('returns an admission receipt before model processing completes when a named agent dispatch is accepted', async () => {
		let releaseProcessing: (() => void) | undefined;
		const processingPending = new Promise<void>((resolve) => {
			releaseProcessing = resolve;
		});
		let processingCompleted = false;
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue({
				async process() {
					await processingPending;
					processingCompleted = true;
				},
			}),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		try {
			const receipt = await dispatch({
				agent: 'moderator',
				id: 'guild:admission',
				session: 'case:admission',
				input: { type: 'flagged', reportId: 'report:admission' },
			});

			expect(receipt).toEqual({
				dispatchId: expect.any(String),
				acceptedAt: expect.any(String),
			});
			expect(processingCompleted).toBe(false);
		} finally {
			releaseProcessing?.();
		}
		await vi.waitFor(() => {
			expect(processingCompleted).toBe(true);
		});
	});

	it('resolves a discovered agent name when dispatch() receives a created agent target', async () => {
		const moderator = createAgent(() => ({ model: false }));
		const admitted: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: {
				async enqueue(input) {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			resolveDispatchAgentName: (candidate) => (candidate === moderator ? 'moderator' : undefined),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await dispatch(moderator, {
			id: 'guild:created',
			session: 'case:created',
			input: { type: 'flagged', reportId: 'report:created' },
		});

		expect(admitted).toMatchObject([
			{
				agent: 'moderator',
				id: 'guild:created',
				session: 'case:created',
				input: { type: 'flagged', reportId: 'report:created' },
			},
		]);
	});

	it('rejects a created agent target when the built application cannot resolve its identity', async () => {
		const localModerator = createAgent(() => ({ model: false }));
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			resolveDispatchAgentName: () => undefined,
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch(localModerator, {
				id: 'guild:local',
				input: { type: 'flagged', reportId: 'report:local' },
			}),
		).rejects.toThrow('not a discovered default-exported agent');
	});

	it('defaults the session name when dispatch() receives no session', async () => {
		const admitted: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: {
				async enqueue(input) {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await dispatch({
			agent: 'moderator',
			id: 'guild:default-session',
			input: { type: 'flagged', reportId: 'report:default-session' },
		});

		expect(admitted).toMatchObject([
			{
				agent: 'moderator',
				id: 'guild:default-session',
				session: 'default',
				input: { type: 'flagged', reportId: 'report:default-session' },
			},
		]);
	});

	it('snapshots JSON-like input when dispatch() admits a payload', async () => {
		const admitted: DispatchInput[] = [];
		const payload = { type: 'flagged', report: { id: 'report:snapshot', count: 1 } };
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: {
				async enqueue(input) {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await dispatch({ agent: 'moderator', id: 'guild:snapshot', input: payload });
		payload.report.count = 2;

		expect(admitted[0]?.input).toEqual({
			type: 'flagged',
			report: { id: 'report:snapshot', count: 1 },
		});
	});

	it('rejects missing input when dispatch() receives an undefined payload', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'moderator', id: 'guild:undefined-input', input: undefined }),
		).rejects.toThrow('requires an "input" payload');
	});

	it('rejects non-JSON-like input when dispatch() receives a function value', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({
				agent: 'moderator',
				id: 'guild:function-input',
				input: { type: 'flagged', callback: () => 'unsupported' },
			}),
		).rejects.toThrow('must not contain function values');
	});

	it('rejects non-JSON-like input when dispatch() receives a bigint value', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({
				agent: 'moderator',
				id: 'guild:bigint-input',
				input: { type: 'flagged', reportId: 1n },
			}),
		).rejects.toThrow('must not contain bigint values');
	});

	it('rejects non-JSON-like input when dispatch() receives a non-plain object', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({
				agent: 'moderator',
				id: 'guild:date-input',
				input: { type: 'flagged', acceptedAt: new Date('2026-06-01T00:00:00.000Z') },
			}),
		).rejects.toThrow('must contain only plain JSON objects');
	});

	it('rejects an unknown agent when dispatch() targets an unregistered name', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'missing', id: 'guild:unknown-agent', input: { type: 'flagged' } }),
		).rejects.toThrow('target agent "missing" is not registered');
	});

	it('rejects a blank agent instance id when dispatch() receives an id', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'moderator', id: '  ', input: { type: 'flagged' } }),
		).rejects.toThrow('requires a non-empty "id" target agent instance id');
	});

	it('rejects a blank session name when dispatch() receives a session', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'moderator', id: 'guild:blank-session', session: '  ', input: null }),
		).rejects.toThrow('requires a non-empty "session" target session id');
	});

	it('rejects calls when the runtime has no dispatch queue', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'moderator', id: 'guild:no-queue', input: { type: 'flagged' } }),
		).rejects.toThrow('no dispatch queue is configured');
	});
});

describe('dispatched session processing', () => {
	it('preserves admission order when the default Node queue processes multiple inputs for one agent instance session', async () => {
		let releaseFirst: (() => void) | undefined;
		const firstPending = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const processingOrder: string[] = [];
		const queue = new InMemoryDispatchQueue({
			async process(input) {
				processingOrder.push(input.dispatchId);
				if (input.dispatchId === 'dispatch:queue:first') await firstPending;
			},
		});

		try {
			await queue.enqueue({
				dispatchId: 'dispatch:queue:first',
				agent: 'moderator',
				id: 'guild:queue',
				session: 'case:queue',
				input: { type: 'flagged', reportId: 'report:queue:first' },
				acceptedAt: '2026-06-01T00:00:00.000Z',
			});
			await queue.enqueue({
				dispatchId: 'dispatch:queue:second',
				agent: 'moderator',
				id: 'guild:queue',
				session: 'case:queue',
				input: { type: 'flagged', reportId: 'report:queue:second' },
				acceptedAt: '2026-06-01T00:00:01.000Z',
			});
			await vi.waitFor(() => {
				expect(processingOrder).toEqual(['dispatch:queue:first']);
			});
		} finally {
			releaseFirst?.();
		}

		await vi.waitFor(() => {
			expect(processingOrder).toEqual(['dispatch:queue:first', 'dispatch:queue:second']);
		});
	});

	it('exposes instanceId and dispatchId without runId when observe() receives dispatched agent activity', async () => {
		const events: unknown[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'guild:observe-dispatch') events.push(event);
		});
		const processor = createAgentDispatchProcessor({
			agents: { moderator: createAgent(() => ({ model: false })) },
			createContext: (...args) => {
				const ctx = createTestContext(...args);
				ctx.initializeCreatedAgent = async () =>
					({
						name: 'default',
						session: async (name?: string) =>
							({
								name: name ?? 'default',
								processDispatchInput: async () => {
									ctx.emitEvent({ type: 'idle' });
								},
							}) as unknown as FlueSession & {
								processDispatchInput(input: DispatchInput): Promise<void>;
							},
						sessions: {} as never,
						shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
						fs: {} as never,
					}) satisfies FlueHarness;
				return ctx;
			},
		});

		try {
			await processor.process({
				dispatchId: 'dispatch:observe',
				agent: 'moderator',
				id: 'guild:observe-dispatch',
				session: 'case:observe-dispatch',
				input: { type: 'flagged', reportId: 'report:observe-dispatch' },
				acceptedAt: '2026-06-01T00:00:00.000Z',
			});

			expect(events).toEqual([
				{
					type: 'idle',
					instanceId: 'guild:observe-dispatch',
					dispatchId: 'dispatch:observe',
					eventIndex: 0,
					timestamp: expect.any(String),
				},
			]);
			expect(events[0]).not.toHaveProperty('runId');
		} finally {
			stopObserving();
		}
	});

	it('avoids creating workflow run history when a dispatched input is processed', async () => {
		const contextRunIds: Array<string | undefined> = [];
		const contextDispatchIds: Array<string | undefined> = [];
		const processor = createAgentDispatchProcessor({
			agents: { moderator: createAgent(() => ({ model: false })) },
			createContext: (...args) => {
				contextRunIds.push(args[1]);
				contextDispatchIds.push(args[5]);
				const ctx = createTestContext(...args);
				ctx.initializeCreatedAgent = async () =>
					({
						name: 'default',
						session: async (name?: string) =>
							({
								name: name ?? 'default',
								processDispatchInput: async () => {},
							}) as unknown as FlueSession & {
								processDispatchInput(input: DispatchInput): Promise<void>;
							},
						sessions: {} as never,
						shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
						fs: {} as never,
					}) satisfies FlueHarness;
				return ctx;
			},
		});

		await processor.process({
			dispatchId: 'dispatch:no-run-history',
			agent: 'moderator',
			id: 'guild:no-run-history',
			session: 'case:no-run-history',
			input: { type: 'flagged', reportId: 'report:no-run-history' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		});

		expect(contextRunIds).toEqual([undefined]);
		expect(contextDispatchIds).toEqual(['dispatch:no-run-history']);
	});

	// TODO(RUNTIME-27): Migrate these retry tests to a stable generated-runtime boundary.
	it('avoids repeating model processing when the same dispatch id is retried before the session advances', async () => {
		const store = new InMemorySessionStore();
		const harness = new Harness(
			'guild:retry-idempotent',
			'default',
			testAgentConfig(),
			createNoopSessionEnv({ cwd: '/' }),
			store,
		);
		const session = await harness.session('case:retry-idempotent');
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[] };
			continue: () => Promise<void>;
			waitForIdle: () => Promise<void>;
		};
		let modelProcessingCount = 0;
		agent.continue = async () => {
			modelProcessingCount += 1;
			agent.state.messages.push(assistantMessage('processed idempotently'));
		};
		agent.waitForIdle = async () => {};
		const dispatchedSession = session as FlueSession & {
			processDispatchInput(input: DispatchInput): PromiseLike<unknown>;
		};
		const input: DispatchInput = {
			dispatchId: 'dispatch:retry-idempotent',
			agent: 'moderator',
			id: 'guild:retry-idempotent',
			session: 'case:retry-idempotent',
			input: { type: 'flagged', reportId: 'report:retry-idempotent' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};

		await dispatchedSession.processDispatchInput(input);
		await dispatchedSession.processDispatchInput(input);

		const data = await store.load(
			'agent-session:["guild:retry-idempotent","default","case:retry-idempotent"]',
		);
		expect(modelProcessingCount).toBe(1);
		expect(
			data?.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user'),
		).toHaveLength(1);
		expect(data?.entries[0]).toMatchObject({
			source: 'dispatch',
			dispatch: { dispatchId: 'dispatch:retry-idempotent' },
		});
	});

	it('rejects a retried dispatch when later user input has already advanced the session', async () => {
		const store = new InMemorySessionStore();
		const harness = new Harness(
			'guild:retry-advanced',
			'default',
			testAgentConfig(),
			createNoopSessionEnv({ cwd: '/' }),
			store,
		);
		const session = await harness.session('case:retry-advanced');
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[] };
			continue: () => Promise<void>;
			waitForIdle: () => Promise<void>;
		};
		agent.continue = async () => {
			agent.state.messages.push(assistantMessage('processed before advancement'));
		};
		agent.waitForIdle = async () => {};
		const dispatchedSession = session as FlueSession & {
			processDispatchInput(input: DispatchInput): PromiseLike<unknown>;
		};
		const input: DispatchInput = {
			dispatchId: 'dispatch:retry-advanced',
			agent: 'moderator',
			id: 'guild:retry-advanced',
			session: 'case:retry-advanced',
			input: { type: 'flagged', reportId: 'report:retry-advanced' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};

		await dispatchedSession.processDispatchInput(input);
		await dispatchedSession.processDispatchInput({
			dispatchId: 'dispatch:retry-advanced:later',
			agent: 'moderator',
			id: 'guild:retry-advanced',
			session: 'case:retry-advanced',
			input: { type: 'flagged', reportId: 'report:retry-advanced:later' },
			acceptedAt: '2026-06-01T00:00:01.000Z',
		});

		await expect(dispatchedSession.processDispatchInput(input)).rejects.toThrow(
			'Cannot recover dispatched input after the session has advanced',
		);
	});
});

function createTestContext(
	id: string,
	runId: string | undefined,
	payload: unknown,
	req: Request,
	initialEventIndex?: number,
	dispatchId?: string,
) {
	return createFlueContext({
		id,
		runId,
		dispatchId,
		payload,
		env: {},
		req,
		initialEventIndex,
		agentConfig: testAgentConfig(),
		createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
		defaultStore: new InMemorySessionStore(),
	});
}

function testAgentConfig(): AgentConfig {
	return {
		systemPrompt: '',
		skills: {},
		subagents: {},
		model: { id: 'test-model', provider: 'test', api: 'test' } as never,
		resolveModel: () => ({ id: 'test-model', provider: 'test', api: 'test' }) as never,
	};
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AgentMessage;
}
