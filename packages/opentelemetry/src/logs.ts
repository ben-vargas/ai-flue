import type { Attributes } from '@opentelemetry/api';

export interface GenAILogger {
	emit(record: {
		eventName: string;
		severityNumber?: number;
		severityText?: string;
		attributes?: Attributes;
	}): void;
}

export function emitInferenceException(
	logger: GenAILogger | undefined,
	attributes: Attributes,
): void {
	logger?.emit({
		eventName: 'gen_ai.client.operation.exception',
		severityNumber: 13,
		severityText: 'WARN',
		attributes,
	});
}

/**
 * A coordinator recovery/reconciliation failure, contained instead of
 * settling the submission (`FlueEventVariant['submission_recovery']`). No
 * span accompanies this record: recovery happens outside any intercepted
 * execution, so there is no live operation/turn/tool span to attach to and
 * fabricating a parentless one would only add noise. Attributes stay
 * low-cardinality and stackless by construction — callers never pass a raw
 * message or stack.
 */
export function emitSubmissionRecovery(
	logger: GenAILogger | undefined,
	attributes: Attributes,
): void {
	logger?.emit({
		eventName: 'flue.submission_recovery',
		severityNumber: 13,
		severityText: 'WARN',
		attributes,
	});
}
