/**
 * Contract tests for the Postgres persistence adapter.
 *
 * Uses PGlite (embedded Postgres in WASM) so no external server is needed.
 * Uses the shared contract test runner from @flue/runtime for behavioral
 * assertions, plus adapter-specific factory tests.
 */

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { PersistedSchemaVersionError, type SessionData } from '@flue/runtime/adapter';
import { postgresFromRunner, type PgRunner } from '../src/postgres-adapter.ts';
import {
	defineEventStreamStoreContractTests,
	defineRunStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';

// ─── PGlite → PgRunner adapter ─────────────────────────────────────────────

function createPgliteRunner(): PgRunner {
	const db = new PGlite();
	return {
		async query(text: string, params: unknown[] = []) {
			const result = await db.query(text, params);
			return (result.rows ?? []) as Record<string, unknown>[];
		},
		async transaction<T>(fn: (tx: PgRunner) => Promise<T>): Promise<T> {
			return db.transaction(async (pgTx) => {
				const txRunner: PgRunner = {
					async query(text: string, params: unknown[] = []) {
						const result = await pgTx.query(text, params);
						return (result.rows ?? []) as Record<string, unknown>[];
					},
					transaction: () => {
						throw new Error('Nested transactions not supported');
					},
					close: () => Promise.resolve(),
				};
				return fn(txRunner);
			});
		},
		async close() {
			await db.close();
		},
	};
}

// ─── Contract tests (shared) ────────────────────────────────────────────────

{
	let adapter: ReturnType<typeof postgresFromRunner> | undefined;
	defineStoreContractTests('Postgres AgentExecutionStore', {
		async create() {
			adapter = postgresFromRunner(createPgliteRunner());
			await adapter.migrate?.();
			const { executionStore } = await adapter.connect();
			return executionStore;
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

{
	let adapter: ReturnType<typeof postgresFromRunner> | undefined;
	defineEventStreamStoreContractTests('Postgres EventStreamStore', {
		async create() {
			adapter = postgresFromRunner(createPgliteRunner());
			await adapter.migrate?.();
			const { eventStreamStore } = await adapter.connect();
			return eventStreamStore;
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

{
	let adapter: ReturnType<typeof postgresFromRunner> | undefined;
	defineRunStoreContractTests('Postgres RunStore', {
		async create() {
			adapter = postgresFromRunner(createPgliteRunner());
			await adapter.migrate?.();
			const { runStore } = await adapter.connect();
			return runStore;
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

// ─── Adapter factory tests ──────────────────────────────────────────────────

function sessionData(): SessionData {
	return {
		version: 6,
		affinityKey: 'affinity-1',
		entries: [],
		leafId: null,
		taskSessions: [],
		metadata: {},
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
	};
}

describe('postgres() PersistenceAdapter', () => {
	it('creates a store and closes cleanly via postgresFromRunner', async () => {
		const runner = createPgliteRunner();
		const adapter = postgresFromRunner(runner);
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		await store.sessions.save('s1', sessionData());
		expect(await store.sessions.load('s1')).toEqual(sessionData());
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});

	it('close() is idempotent', async () => {
		const runner = createPgliteRunner();
		const adapter = postgresFromRunner(runner);
		await adapter.migrate?.();
		await adapter.connect();
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
		await adapter.close();
	});

	it('stamps a fresh database and rejects migrate() against a newer schema version', async () => {
		const runner = createPgliteRunner();
		const adapter = postgresFromRunner(runner);
		await adapter.migrate?.();

		const rows = await runner.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`);
		expect(rows).toEqual([{ value: '1' }]);

		await runner.query(`UPDATE flue_meta SET value = '999' WHERE key = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);

		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});
});
