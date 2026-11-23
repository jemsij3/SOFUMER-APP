/**
 * Shared Cloudflare Workers AI model catalog, request/response normalization,
 * JSON extraction, and safe error sanitization used across both Cloudflare Worker
 * edge routes and local Node/Express runtime parity.
 */

export const DEFAULT_CF_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

export const VALID_CF_MODELS = new Set<string>([
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3.8-27b',
]);

export const DEPRECATED_CF_MODELS = new Set<string>([
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/infire-llama-3.1-8b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.1',
  '@cf/mistral/mistral-7b-instruct-v0.2',
  '@cf/qwen/qwen2.5-7b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8',
]);

export function resolveActiveCfAiModel(...candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed && VALID_CF_MODELS.has(trimmed)) {
        return trimmed;
      }
    }
  }
  return DEFAULT_CF_AI_MODEL;
}

export interface WorkersAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface WorkersAiRunInputs {
  messages: WorkersAiMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_object' };
}

export type WorkersAiRawOutput =
  | string
  | ReadableStream<Uint8Array>
  | {
      success?: boolean;
      errors?: Array<{ message?: string; code?: number }>;
      error?: string | { message?: string };
      response?: unknown;
      result?: { response?: unknown; [key: string]: unknown } | unknown;
      choices?: Array<{
        text?: unknown;
        message?: {
          content?: unknown;
          parsed?: unknown;
          reasoning_content?: unknown;
        };
        delta?: { content?: unknown };
      }>;
      output_text?: unknown;
      output?: unknown;
      [key: string]: unknown;
    }
  | null
  | undefined;

export interface WorkersAiBinding {
  run(model: string, inputs: WorkersAiRunInputs): Promise<WorkersAiRawOutput>;
}

export class AiNormalizationError extends Error {
  public readonly userMessage: string;

  constructor(internalMessage: string, userMessage = 'The AI assistant could not generate a valid response. Please try again.') {
    super(internalMessage);
    this.name = 'AiNormalizationError';
    this.userMessage = userMessage;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReadableStreamLike(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReadableStream<Uint8Array>).getReader === 'function'
  );
}

/**
 * Decodes a Workers AI ReadableStream (supporting both SSE `data: {...}` events and raw text chunks).
 */
export async function collectWorkersAiStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        raw += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      }
    }
    raw += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore lock release failures
    }
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AiNormalizationError('Workers AI stream ended with empty output.');
  }

  if (!trimmed.includes('data:')) {
    return trimmed;
  }

  const parts: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') continue;
    try {
      const event = JSON.parse(dataStr) as Record<string, unknown>;
      if (typeof event.response === 'string') {
        parts.push(event.response);
      } else if (
        Array.isArray(event.choices) &&
        event.choices.length > 0 &&
        isPlainRecord(event.choices[0])
      ) {
        const c0 = event.choices[0];
        if (isPlainRecord(c0.delta) && typeof c0.delta.content === 'string') {
          parts.push(c0.delta.content);
        } else if (isPlainRecord(c0.message) && typeof c0.message.content === 'string') {
          parts.push(c0.message.content);
        } else if (typeof c0.text === 'string') {
          parts.push(c0.text);
        }
      } else if (typeof event.text === 'string') {
        parts.push(event.text);
      }
    } catch {
      parts.push(dataStr);
    }
  }

  const joined = parts.join('').trim();
  return joined || trimmed;
}

function extractTextFromContentArray(items: unknown[]): string {
  const chunks: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) chunks.push(item.trim());
    } else if (isPlainRecord(item)) {
      if (typeof item.text === 'string' && item.text.trim()) {
        chunks.push(item.text.trim());
      } else if (typeof item.output_text === 'string' && item.output_text.trim()) {
        chunks.push(item.output_text.trim());
      } else if (typeof item.content === 'string' && item.content.trim()) {
        chunks.push(item.content.trim());
      } else if (Array.isArray(item.content)) {
        const nested = extractTextFromContentArray(item.content);
        if (nested) chunks.push(nested);
      }
    }
  }
  return chunks.join('\n').trim();
}

function assertNoErrorEnvelope(out: Record<string, unknown>) {
  if (out.success === false && Array.isArray(out.errors) && out.errors.length > 0) {
    const first = out.errors[0];
    const msg = isPlainRecord(first) && typeof first.message === 'string'
      ? first.message.trim()
      : 'Cloudflare Workers AI returned an execution error.';
    throw new AiNormalizationError(msg);
  }
  if (out.error !== undefined && out.error !== null) {
    const msg =
      typeof out.error === 'string'
        ? out.error.trim()
        : isPlainRecord(out.error) && typeof out.error.message === 'string'
        ? out.error.message.trim()
        : 'Cloudflare Workers AI returned an error response.';
    if (msg) throw new AiNormalizationError(msg);
  }
}

/**
 * Unwraps the inner response payload from any Cloudflare Workers AI / OpenAI-compatible envelope.
 */
async function unwrapWorkersAiPayload(rawOutput: unknown, preferParsedObject: boolean): Promise<unknown> {
  if (rawOutput === null || rawOutput === undefined) {
    throw new AiNormalizationError('Workers AI returned null or undefined.');
  }

  if (isReadableStreamLike(rawOutput)) {
    return await collectWorkersAiStream(rawOutput);
  }

  if (typeof rawOutput === 'string') {
    const trimmed = rawOutput.trim();
    if (!trimmed) throw new AiNormalizationError('Workers AI returned an empty string.');
    return trimmed;
  }

  if (Array.isArray(rawOutput)) {
    return rawOutput;
  }

  if (!isPlainRecord(rawOutput)) {
    throw new AiNormalizationError(`Unsupported Workers AI output type: ${typeof rawOutput}`);
  }

  assertNoErrorEnvelope(rawOutput);

  // 1. Standard Workers AI envelope: { response: string | object }
  if (rawOutput.response !== undefined && rawOutput.response !== null) {
    return rawOutput.response;
  }

  // 2. REST API / nested result envelope: { result: { response: ... } } or { result: ... }
  if (rawOutput.result !== undefined && rawOutput.result !== null) {
    if (isPlainRecord(rawOutput.result)) {
      if (rawOutput.result.response !== undefined && rawOutput.result.response !== null) {
        return rawOutput.result.response;
      }
      if (
        Array.isArray(rawOutput.result.choices) ||
        rawOutput.result.output_text !== undefined ||
        rawOutput.result.output !== undefined
      ) {
        return unwrapWorkersAiPayload(rawOutput.result, preferParsedObject);
      }
    }
    return rawOutput.result;
  }

  // 3. OpenAI-compatible Chat Completions envelope: { choices: [{ message: { content, parsed }, text }] }
  if (Array.isArray(rawOutput.choices) && rawOutput.choices.length > 0) {
    const firstChoice = rawOutput.choices[0];
    if (isPlainRecord(firstChoice)) {
      if (isPlainRecord(firstChoice.message)) {
        if (preferParsedObject && isPlainRecord(firstChoice.message.parsed)) {
          return firstChoice.message.parsed;
        }
        if (firstChoice.message.content !== undefined && firstChoice.message.content !== null) {
          return firstChoice.message.content;
        }
        if (firstChoice.message.parsed !== undefined && firstChoice.message.parsed !== null) {
          return firstChoice.message.parsed;
        }
      }
      if (firstChoice.text !== undefined && firstChoice.text !== null) {
        return firstChoice.text;
      }
      if (isPlainRecord(firstChoice.delta) && firstChoice.delta.content !== undefined) {
        return firstChoice.delta.content;
      }
    }
  }

  // 4. OpenAI Responses format: { output_text } or { output: [...] }
  if (typeof rawOutput.output_text === 'string' && rawOutput.output_text.trim()) {
    return rawOutput.output_text;
  }
  if (Array.isArray(rawOutput.output) && rawOutput.output.length > 0) {
    return rawOutput.output;
  }

  // 5. Direct structured object without outer wrapper (e.g. { answer: ..., matchedProductIds: ... })
  return rawOutput;
}

/**
 * Normalizes any Workers AI text generation payload into a clean, non-empty string.
 * Never invokes `.trim()` on non-strings and never returns `[object Object]`.
 */
export async function normalizeAiText(rawOutput: unknown): Promise<string> {
  const payload = await unwrapWorkersAiPayload(rawOutput, false);

  if (typeof payload === 'string') {
    const cleaned = payload.trim();
    if (!cleaned) throw new AiNormalizationError('Workers AI returned an empty text response.');
    return cleaned;
  }

  if (Array.isArray(payload)) {
    const extracted = extractTextFromContentArray(payload);
    if (!extracted) {
      throw new AiNormalizationError('Workers AI returned an empty array response.');
    }
    return extracted;
  }

  if (isPlainRecord(payload)) {
    const candidateKeys = [
      'response',
      'text',
      'content',
      'answer',
      'reply',
      'comparison',
      'insights',
      'message',
      'output_text',
      'rationale',
      'summary',
    ];
    for (const key of candidateKeys) {
      const val = payload[key];
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
      if (Array.isArray(val)) {
        const nested = extractTextFromContentArray(val);
        if (nested) return nested;
      }
    }
    throw new AiNormalizationError('Workers AI returned an object without a readable text field.');
  }

  throw new AiNormalizationError(`Workers AI returned unexpected non-text type: ${typeof payload}`);
}

/**
 * Normalizes any Workers AI structured JSON response (string, markdown-fenced JSON,
 * OpenAI choices payload, ReadableStream, or an already-parsed JS object from `response_format`)
 * into a validated plain record. Never calls `.trim()` on objects, arrays, null, or undefined.
 */
export async function normalizeAiJsonObject(
  rawOutput: unknown
): Promise<{ data: Record<string, unknown>; estimatedTokens: number }> {
  const payload = await unwrapWorkersAiPayload(rawOutput, true);

  if (isPlainRecord(payload)) {
    if (Object.keys(payload).length === 0) {
      throw new AiNormalizationError('Workers AI returned an empty JSON object.');
    }
    return {
      data: payload,
      estimatedTokens: estimateTokens(payload),
    };
  }

  let textCandidate = '';
  if (typeof payload === 'string') {
    textCandidate = payload;
  } else if (Array.isArray(payload)) {
    textCandidate = extractTextFromContentArray(payload);
  } else {
    throw new AiNormalizationError(`Workers AI returned non-JSON payload type: ${typeof payload}`);
  }

  const trimmed = textCandidate.trim();
  if (!trimmed) {
    throw new AiNormalizationError('Workers AI returned empty text for a JSON request.');
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced && typeof fenced[1] === 'string' ? fenced[1] : trimmed).trim();

  const tryParseRecord = (input: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (isPlainRecord(parsed)) return parsed;
      if (typeof parsed === 'string') {
        const inner = JSON.parse(parsed) as unknown;
        if (isPlainRecord(inner)) return inner;
      }
      return null;
    } catch {
      return null;
    }
  };

  let parsedRecord = tryParseRecord(candidate);
  if (!parsedRecord) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      parsedRecord = tryParseRecord(candidate.slice(start, end + 1));
    }
  }

  if (!parsedRecord) {
    throw new AiNormalizationError('Workers AI returned malformed JSON that could not be parsed.');
  }

  return {
    data: parsedRecord,
    estimatedTokens: estimateTokens(candidate),
  };
}

export function estimateTokens(value: unknown): number {
  if (typeof value === 'string') {
    return value.length > 0 ? Math.max(1, Math.ceil(value.length / 4)) : 0;
  }
  if (value !== null && value !== undefined && typeof value === 'object') {
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > 0 ? Math.max(1, Math.ceil(serialized.length / 4)) : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function coerceAiString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const joined = extractTextFromContentArray(value);
    return joined || fallback;
  }
  return fallback;
}

export function coerceAiStringList(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) return [];
  const results: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const cleaned = item.trim();
      if (cleaned) results.push(cleaned);
    } else if (isPlainRecord(item) && typeof item.text === 'string' && item.text.trim()) {
      results.push(item.text.trim());
    }
    if (results.length >= maxItems) break;
  }
  return results;
}

/**
 * Executes a Workers AI binding with automatic fallback when a model rejects `response_format`.
 */
export async function runWorkersAiWithJsonFallback(
  aiBinding: WorkersAiBinding,
  modelName: string,
  messages: WorkersAiMessage[],
  expectJson: boolean,
  maxTokens = 900,
  temperature = 0.2
): Promise<WorkersAiRawOutput> {
  const baseInput: WorkersAiRunInputs = {
    messages,
    max_tokens: maxTokens,
    temperature,
  };

  if (!expectJson) {
    return await aiBinding.run(modelName, baseInput);
  }

  try {
    return await aiBinding.run(modelName, {
      ...baseInput,
      response_format: { type: 'json_object' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    const isSchemaFlagRejected =
      msg.includes('response_format') ||
      msg.includes('json_object') ||
      msg.includes('schema') ||
      msg.includes('unsupported property');
    if (isSchemaFlagRejected) {
      return await aiBinding.run(modelName, baseInput);
    }
    throw err;
  }
}

/**
 * Separates detailed technical diagnostics (logged to ai_usage for admins)
 * from safe, friendly user-facing messages (never exposing `.trim is not a function` or stacks).
 */
export function sanitizeAiErrorForUser(err: unknown): {
  internalMessage: string;
  userMessage: string;
} {
  if (err instanceof AiNormalizationError) {
    return {
      internalMessage: err.message,
      userMessage: err.userMessage,
    };
  }

  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown AI error';
  const internalMessage = raw.trim() || 'Unknown AI execution failure';
  const lower = internalMessage.toLowerCase();

  if (lower.includes('binding (env.ai) is not configured') || lower.includes('not bound in this local')) {
    return {
      internalMessage,
      userMessage: 'AI service is temporarily unavailable in this environment. Please try again shortly.',
    };
  }
  if (lower.includes('410') || lower.includes('5028') || lower.includes('deprecated')) {
    return {
      internalMessage,
      userMessage: 'The configured AI model is currently unavailable. Please ask an administrator to refresh the AI model setting.',
    };
  }
  if (lower.includes('rate limit') || lower.includes('too many') || lower.includes('429')) {
    return {
      internalMessage,
      userMessage: 'AI service is busy right now. Please wait a few seconds and try again.',
    };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return {
      internalMessage,
      userMessage: 'The AI request took too long to respond. Please try a shorter prompt.',
    };
  }

  return {
    internalMessage,
    userMessage: 'Unable to complete this AI request right now. Please try again in a moment.',
  };
}
