import { ulid } from 'ulidx';

/**
 * Workflow run ids are opaque: nothing may parse structure out of them. The
 * owning workflow is resolved through the run registry (`runId` →
 * `workflowName`).
 */
export function generateWorkflowRunId(): string {
	return `run_${ulid()}`;
}

export function generateSessionAffinityKey(): string {
	return `aff_${ulid()}`;
}

export function generateConversationId(): string {
	return `conv_${ulid()}`;
}

export function generateOperationId(): string {
	return `op_${ulid()}`;
}

export function generateTurnId(): string {
	return `turn_${ulid()}`;
}
