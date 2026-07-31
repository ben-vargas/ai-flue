import { observe } from './events.ts';

/**
 * Dev-mode lifecycle logging as an `observe()` subscriber: one line when an
 * agent interaction first starts processing (`submission_running` with
 * `attemptCount === 1`), and one for every contained recovery failure
 * (`submission_recovery`) — conditions that otherwise surface only in stderr.
 * `dispose()` unsubscribes.
 */
export function installDevLifecycleLogger(write: (message: string) => void = console.log): {
	dispose(): void;
} {
	const unsubscribe = observe((event) => {
		if (event.type === 'submission_running' && event.attemptCount === 1) {
			write(`[agent] ${event.agentName}@${event.instanceId} started`);
		} else if (event.type === 'submission_recovery') {
			const subject = event.submissionId ?? 'pass';
			const cause = event.error ? `: ${event.error.message}` : '';
			write(`[agent] recovery ${event.operation} → ${event.outcome} (${subject})${cause}`);
		}
	});
	return {
		dispose() {
			unsubscribe();
		},
	};
}
