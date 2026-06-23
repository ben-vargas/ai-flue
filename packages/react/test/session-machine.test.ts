import {
	type AttachedAgentEvent,
	FetchError,
	type FlueClient,
	type FlueEvent,
	type FlueEventStream,
} from '@flue/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../src/agent-session.ts';
import { WorkflowRun } from '../src/workflow-run.ts';

function streamFrom<T>(events: T[], offset = 'offset-1'): FlueEventStream<T> {
	return {
		offset,
		cancel: vi.fn(),
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
}

function failedStream<T>(error: unknown, offset = '-1'): FlueEventStream<T> {
	return {
		offset,
		cancel: vi.fn(),
		[Symbol.asyncIterator]() {
			return {
				next: () => Promise.reject(error),
			};
		},
	};
}

function pendingStream<T>(offset = '-1'): FlueEventStream<T> & { push(event: T): void } {
	let canceled = false;
	let wake: (() => void) | undefined;
	const values: T[] = [];
	return {
		offset,
		push(event) {
			values.push(event);
			wake?.();
		},
		cancel() {
			canceled = true;
			wake?.();
		},
		async *[Symbol.asyncIterator]() {
			while (!canceled) {
				const value = values.shift();
				if (value !== undefined) yield value;
				else await new Promise<void>((resolve) => (wake = resolve));
			}
		},
	};
}

function streamThenFail<T>(event: T, error: unknown, offset: string): FlueEventStream<T> {
	return {
		offset,
		cancel: vi.fn(),
		async *[Symbol.asyncIterator]() {
			yield event;
			throw error;
		},
	};
}

function controlledStream<T>(offset: string): FlueEventStream<T> & {
	finish(): void;
	fail(error: unknown): void;
} {
	let resolve!: (result: IteratorResult<T>) => void;
	let reject!: (error: unknown) => void;
	const next = new Promise<IteratorResult<T>>((resolveNext, rejectNext) => {
		resolve = resolveNext;
		reject = rejectNext;
	});
	return {
		offset,
		cancel: vi.fn(),
		finish() {
			resolve({ value: undefined, done: true });
		},
		fail(error) {
			reject(error);
		},
		[Symbol.asyncIterator]() {
			return { next: () => next };
		},
	};
}

function client(overrides: Partial<FlueClient>): FlueClient {
	return overrides as FlueClient;
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe('AgentSession', () => {
	it('restarts after a StrictMode setup cleanup setup cycle', async () => {
		const stream = vi.fn(() => pendingStream<AttachedAgentEvent>());
		const session = new AgentSession(
			client({ agents: { stream } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);

		session.start();
		session.dispose();
		session.start();
		await settle();

		expect(stream).toHaveBeenCalledTimes(2);
		expect(session.getSnapshot().status).toBe('connecting');
		session.dispose();
	});

	it('becomes idle after a fresh stream 404 and attaches from the admission offset on send', async () => {
		const stream = vi
			.fn()
			.mockReturnValueOnce(
				failedStream<AttachedAgentEvent>(
					new FetchError(404, 'not found', undefined, {}, 'https://flue.test/agents/agent/id'),
				),
			)
			.mockReturnValueOnce(pendingStream<AttachedAgentEvent>('offset-admitted'));
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-admitted',
			submissionId: 'submission-1',
		});
		const session = new AgentSession(
			client({ agents: { stream, send } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);
		session.start();
		await settle();

		expect(session.getSnapshot()).toMatchObject({ messages: [], status: 'idle', error: undefined });
		await session.sendMessage('hello');
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(stream).toHaveBeenCalledTimes(2);
		expect(stream.mock.calls[1]?.[2]).toMatchObject({ live: true, offset: 'offset-admitted' });
		expect(session.getSnapshot().status).toBe('connecting');
		session.dispose();
	});

	it('attaches from admission when send resolves before the initial stream returns 404', async () => {
		const initial = controlledStream<AttachedAgentEvent>('-1');
		const replacement = pendingStream<AttachedAgentEvent>('offset-admitted');
		const stream = vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(replacement);
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-admitted',
			submissionId: 'submission-1',
		});
		const session = new AgentSession(
			client({ agents: { stream, send } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);
		session.start();
		await session.sendMessage('hello');
		initial.fail(
			new FetchError(404, 'not found', undefined, {}, 'https://flue.test/agents/agent/id'),
		);
		await settle();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(stream).toHaveBeenCalledTimes(2);
		expect(stream.mock.calls[1]?.[2]).toMatchObject({ offset: 'offset-admitted' });
		session.dispose();
	});

	it('ignores a canceled StrictMode stream checkpoint after replacement starts', async () => {
		vi.useFakeTimers();
		const stale = controlledStream<AttachedAgentEvent>('offset-stale');
		const active = streamThenFail<AttachedAgentEvent>(
			{
				v: 3,
				type: 'idle',
				eventIndex: 1,
				timestamp: '2026-06-12T00:00:00.000Z',
				instanceId: 'id',
			},
			new TypeError('offline'),
			'offset-active',
		);
		const replacement = pendingStream<AttachedAgentEvent>('offset-active');
		const stream = vi
			.fn()
			.mockReturnValueOnce(stale)
			.mockReturnValueOnce(active)
			.mockReturnValueOnce(replacement);
		const session = new AgentSession(
			client({ agents: { stream } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);

		session.start();
		session.dispose();
		session.start();
		stale.finish();
		await settle();
		await vi.advanceTimersByTimeAsync(1001);

		expect(stream.mock.calls[2]?.[2]).toMatchObject({ offset: 'offset-active' });
		session.dispose();
	});

	it('retries an unexpectedly ended agent stream from its concrete checkpoint', async () => {
		vi.useFakeTimers();
		const stream = vi
			.fn()
			.mockReturnValueOnce(streamFrom<AttachedAgentEvent>([], 'offset-checkpoint'))
			.mockReturnValueOnce(pendingStream<AttachedAgentEvent>('offset-checkpoint'));
		const session = new AgentSession(
			client({ agents: { stream } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);
		session.start();
		await settle();
		expect(session.getSnapshot().status).toBe('connecting');

		await vi.advanceTimersByTimeAsync(1001);

		expect(stream).toHaveBeenCalledTimes(2);
		expect(stream.mock.calls[1]?.[2]).toMatchObject({ offset: 'offset-checkpoint' });
		session.dispose();
	});

	it('does not duplicate an interrupted turn when its partial batch is redelivered', async () => {
		vi.useFakeTimers();
		const start = {
			v: 3,
			type: 'message_start',
			message: { role: 'assistant', content: [] },
			eventIndex: 1,
			timestamp: '2026-06-12T00:00:00.000Z',
			instanceId: 'id',
			submissionId: 'submission-1',
			turnId: 'turn-1',
		} as const satisfies AttachedAgentEvent;
		const delta = {
			v: 3,
			type: 'text_delta',
			text: 'partial',
			eventIndex: 2,
			timestamp: '2026-06-12T00:00:00.001Z',
			instanceId: 'id',
			submissionId: 'submission-1',
			turnId: 'turn-1',
		} as const satisfies AttachedAgentEvent;
		const stream = vi
			.fn()
			.mockReturnValueOnce(streamThenFail(start, new TypeError('offline'), '-1'))
			.mockReturnValueOnce(streamThenFail(delta, new TypeError('offline'), '-1'))
			.mockReturnValueOnce(streamFrom([start, delta], 'offset-2'))
			.mockReturnValueOnce(pendingStream<AttachedAgentEvent>('offset-2'));
		const session = new AgentSession(
			client({ agents: { stream } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);
		session.start();
		await settle();
		await vi.advanceTimersByTimeAsync(1001);
		await vi.advanceTimersByTimeAsync(1001);
		await vi.advanceTimersByTimeAsync(2001);

		expect(session.getSnapshot().messages).toEqual([
			{
				id: 'turn:turn-1',
				role: 'assistant',
				metadata: undefined,
				parts: [{ type: 'text', text: 'partial', state: 'streaming' }],
			},
		]);
		session.dispose();
	});

	it('short-circuits reconnect backoff when a message is sent', async () => {
		vi.useFakeTimers();
		const stream = vi
			.fn()
			.mockReturnValueOnce(failedStream<AttachedAgentEvent>(new TypeError('offline')))
			.mockReturnValueOnce(pendingStream<AttachedAgentEvent>());
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: '-1',
			submissionId: 'submission-1',
		});
		const session = new AgentSession(
			client({ agents: { stream, send } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);
		session.start();
		await settle();

		await session.sendMessage('hello');
		await vi.advanceTimersByTimeAsync(0);

		expect(stream).toHaveBeenCalledTimes(2);
		expect(session.getSnapshot().status).toBe('connecting');
		session.dispose();
	});
});

describe('WorkflowRun', () => {
	it('restarts after a StrictMode setup cleanup setup cycle', async () => {
		const stream = vi.fn(() => pendingStream<FlueEvent>());
		const run = new WorkflowRun(
			client({ runs: { stream } as unknown as FlueClient['runs'] }),
			'run-1',
		);

		run.start();
		run.dispose();
		run.start();
		await settle();

		expect(stream).toHaveBeenCalledTimes(2);
		expect(run.getSnapshot().status).toBe('connecting');
		run.dispose();
	});

	it('ignores a canceled StrictMode workflow checkpoint after replacement starts', async () => {
		vi.useFakeTimers();
		const stale = controlledStream<FlueEvent>('offset-stale');
		const active = streamThenFail<FlueEvent>(
			{
				v: 3,
				type: 'log',
				level: 'info',
				message: 'active',
				eventIndex: 1,
				timestamp: '2026-06-12T00:00:00.000Z',
				runId: 'run-1',
			},
			new TypeError('offline'),
			'offset-active',
		);
		const replacement = pendingStream<FlueEvent>('offset-active');
		const stream = vi
			.fn()
			.mockReturnValueOnce(stale)
			.mockReturnValueOnce(active)
			.mockReturnValueOnce(replacement);
		const run = new WorkflowRun(
			client({ runs: { stream } as unknown as FlueClient['runs'] }),
			'run-1',
		);

		run.start();
		run.dispose();
		run.start();
		stale.finish();
		await settle();
		await vi.advanceTimersByTimeAsync(1001);

		expect(stream.mock.calls[2]?.[1]).toMatchObject({ offset: 'offset-active' });
		run.dispose();
	});

	it('does not reconnect after a clean stream closure without run_end', async () => {
		vi.useFakeTimers();
		const stream = vi.fn(() => streamFrom<FlueEvent>([], 'offset-closed'));
		const run = new WorkflowRun(
			client({ runs: { stream } as unknown as FlueClient['runs'] }),
			'run-1',
		);
		run.start();
		await settle();
		await vi.runAllTimersAsync();

		expect(stream).toHaveBeenCalledTimes(1);
		expect(run.getSnapshot()).toMatchObject({ status: 'disconnected', error: undefined });
	});

	it('deduplicates redelivered workflow events', async () => {
		const event = {
			v: 3,
			type: 'log',
			level: 'info',
			message: 'once',
			eventIndex: 1,
			timestamp: '2026-06-12T00:00:00.000Z',
			runId: 'run-1',
		} as const;
		const stream = vi.fn(() => pendingStream<FlueEvent>('offset-1'));
		const run = new WorkflowRun(
			client({ runs: { stream } as unknown as FlueClient['runs'] }),
			'run-1',
		);
		run.start();
		await settle();
		const active = stream.mock.results[0]?.value as FlueEventStream<FlueEvent> & {
			push(event: FlueEvent): void;
		};
		active.push(event);
		active.push(event);
		await settle();

		expect(run.getSnapshot().events).toHaveLength(1);
		expect(run.getSnapshot().logs).toHaveLength(1);
		run.dispose();
	});

	it('retries transient failures from the concrete checkpoint and remains connecting', async () => {
		vi.useFakeTimers();
		const stream = vi
			.fn()
			.mockReturnValueOnce(failedStream<FlueEvent>(new TypeError('offline'), 'offset-7'))
			.mockReturnValueOnce(pendingStream<FlueEvent>('offset-7'));
		const run = new WorkflowRun(
			client({ runs: { stream } as unknown as FlueClient['runs'] }),
			'run-1',
		);
		run.start();
		await settle();

		expect(run.getSnapshot()).toMatchObject({
			status: 'connecting',
			error: new TypeError('offline'),
		});
		await vi.advanceTimersByTimeAsync(1001);

		expect(stream).toHaveBeenCalledTimes(2);
		expect(stream.mock.calls[1]?.[1]).toMatchObject({ offset: 'offset-7' });
		run.dispose();
	});
});
