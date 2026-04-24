// Minimal OpenAI-compatible chat client using fetch.
// Targets OmniRouter by default (http://localhost:20128/v1).
// Supports tools (function calling) and basic text completion.

const DEFAULT_BASE_URL = 'http://localhost:20128/v1';
const DEFAULT_API_KEY = 'sk-openclaw-eb93eeb09390465f915c8245';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: any;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  tool_choice?: 'auto' | 'none' | any;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | string;
}

export interface ChatResponse {
  id: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function getBaseUrl(): string {
  return (
    process.env.OMNIROUTER_URL ||
    process.env.OPENAI_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
}

export function getApiKey(): string {
  return (
    process.env.OMNIROUTER_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    DEFAULT_API_KEY
  );
}

export function isMockMode(): boolean {
  return process.env.FORGE_MOCK === '1';
}

const RETRY_STATUSES = new Set([429, 503, 502, 529]);
const MAX_RETRIES = 4;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const baseUrl = getBaseUrl();
  const url = baseUrl.endsWith('/v1')
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
      await sleep(delay);
    }
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getApiKey()}`,
        },
        body: JSON.stringify(req),
      });
    } catch (fetchErr: any) {
      // Network error (ECONNREFUSED, timeout, etc.) — always retry
      lastErr = new Error(`LLM unreachable: ${fetchErr.message}`);
      continue;
    }

    if (resp.ok) return (await resp.json()) as ChatResponse;

    const errText = await resp.text();
    lastErr = new Error(`LLM ${resp.status}: ${errText.slice(0, 500)}`);
    if (!RETRY_STATUSES.has(resp.status)) throw lastErr;
  }
  throw lastErr!;
}

export function textOf(msg: ChatMessage | undefined): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  return '';
}
