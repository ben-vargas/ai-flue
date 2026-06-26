import type { UIMessage as AiUIMessage } from 'ai';
import type { UIMessage, UIMessagePart } from '../src/types.ts';

declare const messages: UIMessage[];
const aiMessages: AiUIMessage[] = messages;
void aiMessages;

const identifiedDataPart: UIMessagePart = {
	type: 'data-commit',
	id: 'commit-1',
	data: { status: 'done' },
};
const unidentifiedDataPart: UIMessagePart = {
	type: 'data-notice',
	data: { status: 'ready' },
};
void identifiedDataPart;
void unidentifiedDataPart;
