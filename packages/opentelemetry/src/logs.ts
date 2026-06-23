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
