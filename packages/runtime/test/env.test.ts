import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvLoader, parseEnvFile, selectEnvFile } from '../../cli/src/lib/env.ts';

const keys = ['FLUE_ENV_TEST_FILE', 'FLUE_ENV_TEST_REMOVED', 'FLUE_ENV_TEST_SHELL'] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of keys) {
		const value = original[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe('CLI environment file', () => {
	it('selects default .env unless an alternate file is explicit', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-env-selection-'));
		fs.writeFileSync(path.join(root, 'alternate.env'), 'FLUE_ENV_TEST_FILE=explicit\n');
		expect(selectEnvFile(undefined, root)).toBe(path.join(root, '.env'));
		expect(selectEnvFile('alternate.env', root)).toBe(path.join(root, 'alternate.env'));
	});

	it('parses a selected file when present', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-env-parse-'));
		const envFile = path.join(root, '.env');
		fs.writeFileSync(envFile, 'FLUE_ENV_TEST_FILE=value\n');
		expect(parseEnvFile(envFile)).toMatchObject({ FLUE_ENV_TEST_FILE: 'value' });
	});

	it('preserves shell values and removes deleted file values on reload', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-env-reload-'));
		const envFile = path.join(root, '.env');
		process.env.FLUE_ENV_TEST_SHELL = 'shell';
		delete process.env.FLUE_ENV_TEST_REMOVED;
		fs.writeFileSync(envFile, 'FLUE_ENV_TEST_SHELL=file\nFLUE_ENV_TEST_REMOVED=before\nFLUE_ENV_TEST_FILE=runtime\n');
		const loader = createEnvLoader(envFile);
		loader.apply();
		expect(process.env.FLUE_ENV_TEST_SHELL).toBe('shell');
		expect(process.env.FLUE_ENV_TEST_REMOVED).toBe('before');
		expect(process.env.FLUE_ENV_TEST_FILE).toBe('runtime');
		fs.writeFileSync(envFile, 'FLUE_ENV_TEST_SHELL=file-after\nFLUE_ENV_TEST_FILE=updated\n');
		loader.apply();
		expect(process.env.FLUE_ENV_TEST_SHELL).toBe('shell');
		expect(process.env.FLUE_ENV_TEST_REMOVED).toBeUndefined();
		expect(process.env.FLUE_ENV_TEST_FILE).toBe('updated');
		fs.rmSync(envFile);
		loader.apply();
		expect(process.env.FLUE_ENV_TEST_FILE).toBeUndefined();
		fs.writeFileSync(envFile, 'FLUE_ENV_TEST_FILE=scoped\n');
		await loader.withApplied(async () => {
			expect(process.env.FLUE_ENV_TEST_SHELL).toBe('shell');
			expect(process.env.FLUE_ENV_TEST_FILE).toBe('scoped');
		});
		expect(process.env.FLUE_ENV_TEST_FILE).toBeUndefined();
	});
});
