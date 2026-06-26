import { DataPartValidationError } from './errors.ts';
import { cloneJsonSerializable } from './json-snapshot.ts';
import type { FlueEventInput } from './types.ts';

export interface EmitDataOptions {
	/** Stable lifecycle identity within one data-part name. */
	readonly id?: string;
}

/**
 * Emit trusted structured UI activity onto the current durable event stream.
 *
 * Names contain only letters, numbers, `.`, `_`, or `-`. Payloads are
 * synchronously snapshotted as JSON and persisted verbatim for every authorized
 * stream reader; do not include raw image bytes, secrets, or unsanitized PII.
 * Reusing an `id` with the same name lets consumers reconcile lifecycle updates.
 * Detached tool and Action execution validates the call but does not publish it.
 */
export type EmitData = (name: string, data: unknown, options?: EmitDataOptions) => void;

type DataEvent = Extract<FlueEventInput, { type: 'data' }>;

const DATA_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function createDataEmitter(emit: (event: DataEvent) => void): EmitData {
	return (name, data, options) => {
		if (typeof name !== 'string' || !DATA_NAME_PATTERN.test(name)) {
			throw new DataPartValidationError({ name, field: 'name' });
		}
		if (options?.id !== undefined && typeof options.id !== 'string') {
			throw new DataPartValidationError({ name, field: 'id' });
		}
		let snapshot: unknown;
		try {
			snapshot = cloneJsonSerializable(data, `Data part "${name}" payload`);
		} catch (cause) {
			throw new DataPartValidationError({ name, field: 'data', cause });
		}
		emit({
			type: 'data',
			name,
			...(options?.id === undefined ? {} : { id: options.id }),
			data: snapshot,
		});
	};
}

export const detachedDataEmitter = createDataEmitter(() => {});
