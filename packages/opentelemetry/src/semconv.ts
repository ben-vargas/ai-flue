export const GEN_AI_SEMCONV_REVISION = '4c8addb53718b544134be47e256237026fe88875';
export const GEN_AI_PROJECTION_REVISION = 5;
export const GEN_AI_SCHEMA_URL = 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev';
export const FLUE_TELEMETRY_EXTENSION_REVISION = 3;

export const ATTR = {
	operationName: 'gen_ai.operation.name',
	providerName: 'gen_ai.provider.name',
	requestModel: 'gen_ai.request.model',
	responseModel: 'gen_ai.response.model',
	responseId: 'gen_ai.response.id',
	conversationId: 'gen_ai.conversation.id',
	agentName: 'gen_ai.agent.name',
	workflowName: 'gen_ai.workflow.name',
	requestStream: 'gen_ai.request.stream',
	reasoningLevel: 'gen_ai.request.reasoning.level',
	maxTokens: 'gen_ai.request.max_tokens',
	temperature: 'gen_ai.request.temperature',
	finishReasons: 'gen_ai.response.finish_reasons',
	inputTokens: 'gen_ai.usage.input_tokens',
	outputTokens: 'gen_ai.usage.output_tokens',
	cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
	cacheCreationTokens: 'gen_ai.usage.cache_creation.input_tokens',
	inputMessages: 'gen_ai.input.messages',
	outputMessages: 'gen_ai.output.messages',
	systemInstructions: 'gen_ai.system_instructions',
	toolDefinitions: 'gen_ai.tool.definitions',
	toolName: 'gen_ai.tool.name',
	toolCallId: 'gen_ai.tool.call.id',
	toolType: 'gen_ai.tool.type',
	toolDescription: 'gen_ai.tool.description',
	toolArguments: 'gen_ai.tool.call.arguments',
	toolResult: 'gen_ai.tool.call.result',
	compacted: 'gen_ai.conversation.compacted',
	errorType: 'error.type',
	serverAddress: 'server.address',
	serverPort: 'server.port',
	openaiApiType: 'openai.api.type',
} as const;
