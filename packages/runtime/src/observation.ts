import type {
	FlueEvent,
	FlueEventContext,
	FlueObservation,
	FlueObservationDetail,
} from './types.ts';

export type FlueObservationSubscriber = (
	observation: FlueObservation,
	ctx: FlueEventContext,
) => void | Promise<void>;

export function createObservation(
	event: FlueEvent,
	detail?: FlueObservationDetail,
): FlueObservation {
	return freezeValue(cloneValue({ ...event, ...detail } as FlueObservation));
}

function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
	if (value === null || typeof value !== 'object') return value;
	const existing = seen.get(value);
	if (existing !== undefined) return existing as T;
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(cloneValue(item, seen));
		return copy as T;
	}
	const copy: Record<PropertyKey, unknown> = {};
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) {
		copy[key] = cloneValue((value as Record<PropertyKey, unknown>)[key], seen);
	}
	return copy as T;
}

function freezeValue<T>(value: T, seen = new Set<object>()): T {
	if (value === null || typeof value !== 'object' || seen.has(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		freezeValue((value as Record<PropertyKey, unknown>)[key], seen);
	}
	return Object.freeze(value);
}
