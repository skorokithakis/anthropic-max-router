import { AnthropicRequest, SystemMessage } from '../types.js';

export const REQUIRED_SYSTEM_PROMPT: SystemMessage = {
  type: 'text',
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
};

// List of valid top-level fields for Anthropic API requests
const VALID_REQUEST_FIELDS = new Set([
  'model',
  'max_tokens',
  'system',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'thinking',
  'output_config',
  'output_format',
  // Beta fields. They need the client's anthropic-beta values, which
  // mergeBetaHeader forwards.
  'context_management',
  'cache_control',
]);

/**
 * Strips unknown fields from the request to prevent API errors
 */
export function stripUnknownFields(request: Record<string, unknown>): AnthropicRequest {
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(request)) {
    if (VALID_REQUEST_FIELDS.has(key)) {
      sanitized[key] = request[key];
    }
  }
  return sanitized as unknown as AnthropicRequest;
}

/**
 * Combines the router's required betas with the client's anthropic-beta
 * values, without duplicates. A client feature such as compaction
 * (context_management) is rejected upstream unless its beta is sent.
 */
export function mergeBetaHeader(
  routerBetas: string,
  clientHeader: string | string[] | undefined
): string {
  const client = Array.isArray(clientHeader) ? clientHeader.join(',') : (clientHeader ?? '');
  const betas = [...routerBetas.split(','), ...client.split(',')]
    .map((beta) => beta.trim())
    .filter((beta) => beta.length > 0);
  return [...new Set(betas)].join(',');
}

/**
 * Normalizes system prompt to SystemMessage[] format
 * Handles both string and array inputs
 */
function normalizeSystemPrompt(system?: SystemMessage[] | string): SystemMessage[] {
  if (!system) {
    return [];
  }
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }];
  }
  return system;
}

/**
 * Checks if the first system message matches the required Claude Code prompt
 */
function hasRequiredSystemPrompt(system?: SystemMessage[] | string): boolean {
  const normalizedSystem = normalizeSystemPrompt(system);
  if (normalizedSystem.length === 0) {
    return false;
  }

  const firstMessage = normalizedSystem[0];
  return firstMessage.type === 'text' && firstMessage.text === REQUIRED_SYSTEM_PROMPT.text;
}

/**
 * Ensures the required system prompt is present as the first element
 * If it's already there, returns the request unchanged
 * If not, prepends the required prompt
 */
export function ensureRequiredSystemPrompt(request: AnthropicRequest): AnthropicRequest {
  // If the required prompt is already first, return as-is
  if (hasRequiredSystemPrompt(request.system)) {
    return request;
  }

  // Otherwise, prepend the required normalized prompt
  const existingSystem = normalizeSystemPrompt(request.system);
  return {
    ...request,
    system: [REQUIRED_SYSTEM_PROMPT, ...existingSystem],
  };
}
