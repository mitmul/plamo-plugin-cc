// HTTP client for the PLaMo API (https://docs.plamo.preferredai.jp/).
//
// The API is OpenAI-compatible, but this server talks to it with plain `fetch`
// so that the plugin has no dependencies to install.

import { parseSse } from './sse.mjs';
import { abortError, sleep } from './util.mjs';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Answers that mean the API turned the request away before doing anything with it. */
const UNPROCESSED_STATUS = new Set([408, 425, 429]);
/** Network failures that happen before a request can have been sent. */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const MAX_BACKOFF_MS = 20_000;
/** A Retry-After longer than this is reported to the caller instead of waited out. */
const MAX_RETRY_AFTER_MS = 60_000;

export class PlamoApiError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {number | null} [details.status]  HTTP status, when the API answered.
   * @param {string | null} [details.hint]  What the user can do about it.
   * @param {boolean} [details.retryable]
   * @param {boolean} [details.unprocessed]  The API certainly did not act on the request, so repeating it cannot do anything twice.
   * @param {number | null} [details.retryAfterMs]
   */
  constructor(message, { status = null, hint = null, retryable = false, unprocessed = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'PlamoApiError';
    this.status = status;
    this.hint = hint;
    this.retryable = retryable;
    this.unprocessed = unprocessed;
    this.retryAfterMs = retryAfterMs;
  }

  /** Text shown to the model (and through it, the user) when a tool call fails. */
  toToolMessage() {
    const head = this.status ? `PLaMo API error (HTTP ${this.status}): ${this.message}` : `PLaMo error: ${this.message}`;
    return this.hint ? `${head}\n${this.hint}` : head;
  }
}

/** Pull a readable message out of an error body. The API uses `detail` or `message`. */
export function extractErrorMessage(bodyText) {
  const text = String(bodyText ?? '').trim();
  try {
    const json = JSON.parse(text);
    if (typeof json?.detail === 'string') return json.detail;
    if (Array.isArray(json?.detail)) {
      // Validation errors: [{ loc: ["body", "messages"], msg: "field required" }]
      const parts = json.detail.map((item) => {
        if (typeof item === 'string') return item;
        const location = Array.isArray(item?.loc) ? item.loc.filter((part) => part !== 'body').join('.') : '';
        return location ? `${location}: ${item?.msg ?? JSON.stringify(item)}` : (item?.msg ?? JSON.stringify(item));
      });
      if (parts.length > 0) return parts.join('; ');
    }
    if (typeof json?.message === 'string') return json.message;
    if (typeof json?.error === 'string') return json.error;
    if (typeof json?.error?.message === 'string') return json.error.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text ? text.slice(0, 500) : '(empty response body)';
}

function hintForStatus(status, message) {
  if (status === 401) return 'The API key was rejected. Run /plamo:setup to check how the key is configured.';
  if (status === 403) return 'This API key is not allowed to use the requested model or feature.';
  if (status === 404 && /model/i.test(message)) {
    return 'Check the model name (plugin option "Model" or PLAMO_MODEL). The status tool lists the models this key can use.';
  }
  if (status === 429) {
    return 'Rate limit or usage quota reached. PLaMo allows 100 requests per minute per API key, and Free plans have a usage cap. Wait a moment and try again.';
  }
  if (status >= 500) return 'The PLaMo API is temporarily unavailable. Try again later.';
  return null;
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Flatten `url_citation` annotations. Chat Completions nests the citation
 * under `url_citation`; the Responses API puts its fields on the annotation.
 * @returns {{ url: string, title: string, startIndex: number | null, endIndex: number | null }[]}
 */
export function normaliseAnnotations(annotations) {
  if (!Array.isArray(annotations)) return [];
  return annotations
    .map((annotation) => annotation?.url_citation ?? annotation)
    .filter((citation) => typeof citation?.url === 'string')
    .map((citation) => ({
      url: citation.url,
      title: typeof citation.title === 'string' ? citation.title : '',
      startIndex: Number.isInteger(citation.start_index) ? citation.start_index : null,
      endIndex: Number.isInteger(citation.end_index) ? citation.end_index : null,
    }));
}

function normaliseUsage(usage, details) {
  const webSearches = (Array.isArray(details) ? details : [])
    .filter((entry) => entry?.usage_type === 'web_search')
    .reduce((total, entry) => total + (Number(entry.token_consumed) || 0), 0);
  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    webSearches,
  };
}

/**
 * @typedef {object} ChatResult
 * @property {string | null} id
 * @property {string | null} model
 * @property {string} content
 * @property {string | null} finishReason
 * @property {{ url: string, title: string, startIndex: number | null, endIndex: number | null }[]} annotations
 * @property {{ inputTokens: number | null, outputTokens: number | null, reasoningTokens: number, webSearches: number }} usage
 */

function completionFromJson(json) {
  const choice = json?.choices?.[0] ?? {};
  return {
    id: json?.id ?? null,
    model: json?.model ?? null,
    content: typeof choice.message?.content === 'string' ? choice.message.content : '',
    finishReason: choice.finish_reason ?? null,
    annotations: normaliseAnnotations(choice.message?.annotations),
    usage: normaliseUsage(json?.usage, json?.plamo_usage_details),
  };
}

async function completionFromStream(body, onText) {
  const result = { id: null, model: null, content: '', finishReason: null, annotations: [] };
  let usage = null;
  let usageDetails = null;
  let sawDone = false;

  for await (const { data } of parseSse(body)) {
    if (data === '[DONE]') {
      sawDone = true;
      break;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    // An error can still arrive after the stream has started, in any of the shapes an error body has.
    if (chunk?.error || chunk?.detail || (typeof chunk?.message === 'string' && !Array.isArray(chunk.choices))) {
      throw new PlamoApiError(extractErrorMessage(data));
    }

    result.id ??= chunk.id ?? null;
    result.model ??= chunk.model ?? null;
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        result.content += delta.content;
        onText?.(result.content.length);
      }
      // delta.reasoning is an encrypted blob that only the API can read; it is ignored.
      result.annotations.push(...normaliseAnnotations(delta.annotations));
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.plamo_usage_details) usageDetails = chunk.plamo_usage_details;
  }

  if (!sawDone && result.finishReason === null) {
    throw new PlamoApiError('The response stream ended before the answer was complete.', { retryable: true });
  }
  return { ...result, usage: normaliseUsage(usage, usageDetails) };
}

export class PlamoClient {
  #apiKey;
  #baseUrl;
  #userAgent;
  #fetch;
  #maxRetries;
  #retryBaseMs;
  #requestTimeoutMs;
  #log;
  #keyProblem;

  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string | null} [options.keyProblem]  Why the configured key cannot be used, if it cannot.
   * @param {string} options.baseUrl  e.g. https://api.platform.preferredai.jp/v1
   * @param {string} [options.userAgent]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.maxRetries]
   * @param {number} [options.retryBaseMs]
   * @param {number} [options.requestTimeoutMs]  Upper bound for one generation request.
   * @param {(text: string) => void} [options.log]
   */
  constructor({ apiKey, keyProblem = null, baseUrl, userAgent = 'plamo-plugin-cc', fetchImpl = globalThis.fetch, maxRetries = 2, retryBaseMs = 1000, requestTimeoutMs = 600_000, log = () => {} }) {
    this.#apiKey = apiKey;
    this.#keyProblem = keyProblem;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#userAgent = userAgent;
    this.#fetch = fetchImpl;
    this.#maxRetries = maxRetries;
    this.#retryBaseMs = retryBaseMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#log = log;
  }

  get hasApiKey() {
    return Boolean(this.#apiKey);
  }

  /** GET /models */
  async listModels({ signal } = {}) {
    const json = await this.#json('GET', '/models', { signal, timeoutMs: 30_000 });
    return Array.isArray(json?.data) ? json.data : [];
  }

  /** POST /tokenize */
  async tokenize(body, { signal } = {}) {
    return this.#json('POST', '/tokenize', { body, signal, timeoutMs: 60_000 });
  }

  /**
   * POST /responses (Deep Research jobs). Starting a job is not repeatable:
   * a second request would start, and bill, a second job. So it is retried
   * only when the API certainly did not act on the first one.
   */
  async createResponse(body, { signal } = {}) {
    return this.#json('POST', '/responses', { body, signal, timeoutMs: 60_000, onlyRetryUnprocessed: true });
  }

  /** GET /responses/{id} */
  async getResponse(id, { signal } = {}) {
    return this.#json('GET', `/responses/${encodeURIComponent(id)}`, { signal, timeoutMs: 60_000 });
  }

  /** POST /responses/{id}/cancel */
  async cancelResponse(id, { signal } = {}) {
    return this.#json('POST', `/responses/${encodeURIComponent(id)}/cancel`, { signal, timeoutMs: 60_000 });
  }

  /**
   * GET /responses/{id}?stream=true: the events of a job, replayed from the
   * beginning (or from after `startingAfter`) and then delivered live until
   * the job ends. Not retried; a caller that loses the stream can resume with
   * the sequence number of the last event it saw.
   *
   * @param {string} id
   * @param {{ startingAfter?: number | null, signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {AsyncGenerator<object>}
   */
  async *streamResponse(id, { startingAfter = null, signal, timeoutMs } = {}) {
    const query = startingAfter === null ? '?stream=true' : `?stream=true&starting_after=${encodeURIComponent(startingAfter)}`;
    const call = await this.#open('GET', `/responses/${encodeURIComponent(id)}${query}`, {
      signal,
      timeoutMs: timeoutMs ?? this.#requestTimeoutMs,
    });
    try {
      for await (const { data } of parseSse(call.response.body)) {
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        yield event;
      }
    } catch (error) {
      throw call.classify(error);
    } finally {
      call.release();
    }
  }

  /**
   * POST /chat/completions.
   *
   * The request is always streamed: a long answer would otherwise sit behind
   * the HTTP client's header timeout, and streaming lets the caller report
   * progress.
   *
   * @param {object} params  Request body without `stream`.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {(totalChars: number) => void} [options.onText]
   * @param {boolean} [options.onlyRetryUnprocessed]
   *   For requests that are billed per use (web search): retry only when the API certainly did not act on the request.
   * @returns {Promise<ChatResult>}
   */
  async chatCompletion(params, { signal, onText, onlyRetryUnprocessed = false } = {}) {
    const body = { ...params, stream: true, stream_options: { include_usage: true } };
    return this.#withRetries({ signal, onlyRetryUnprocessed }, async () => {
      const call = await this.#open('POST', '/chat/completions', { body, signal, timeoutMs: this.#requestTimeoutMs });
      try {
        const contentType = call.response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) return completionFromJson(await call.response.json());
        return await completionFromStream(call.response.body, onText);
      } catch (error) {
        throw call.classify(error);
      } finally {
        call.release();
      }
    });
  }

  async #json(method, path, options) {
    return this.#withRetries(options, async () => {
      const call = await this.#open(method, path, options);
      try {
        return await call.response.json();
      } catch (error) {
        throw call.classify(error);
      } finally {
        call.release();
      }
    });
  }

  async #withRetries({ signal, onlyRetryUnprocessed = false }, attempt) {
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (signal?.aborted) throw abortError();
        const repeatable = error instanceof PlamoApiError && error.retryable && (error.unprocessed || !onlyRetryUnprocessed);
        if (!repeatable || attemptIndex >= this.#maxRetries) throw error;
        const jitter = 1 + Math.random() * 0.25;
        const delay = error.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, this.#retryBaseMs * 2 ** attemptIndex * jitter);
        this.#log(`retry ${attemptIndex + 1}/${this.#maxRetries} in ${Math.round(delay)}ms: ${error.message}`);
        await sleep(delay, signal);
      }
    }
  }

  /**
   * Send one request and return the successful response. The timeout keeps
   * running until `release()` so that it also covers reading the body.
   */
  async #open(method, path, { body, signal, timeoutMs }) {
    if (!this.#apiKey) {
      throw new PlamoApiError(this.#keyProblem ?? 'The PLaMo API key is not configured.', {
        hint: 'Run /plamo:setup for instructions: set the "PLaMo API key" option of this plugin (/plugin, Installed tab, plamo, Configure), or export PLAMO_API_KEY in the shell that starts Claude Code.',
      });
    }
    if (signal?.aborted) throw abortError();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    // Turn whatever went wrong while sending or reading into an error worth showing.
    const classify = (error) => {
      if (signal?.aborted) return abortError();
      if (timedOut) return new PlamoApiError(`The request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      if (error instanceof PlamoApiError) return error;
      if (error instanceof SyntaxError) {
        return new PlamoApiError('The API answered with something that is not JSON.', {
          hint: 'Check PLAMO_BASE_URL and any proxy between this machine and the API.',
        });
      }
      const code = error?.cause?.code ?? null;
      const reason = this.#redact(String(code ?? error?.cause?.message ?? error?.message ?? error));
      // Once a response has begun, the request did arrive: the connection was lost on the way back.
      if (response !== undefined) {
        return new PlamoApiError(`The connection to the PLaMo API broke off before the answer was complete (${reason}).`, {
          retryable: true,
          hint: 'Check the network connection and any proxy settings.',
        });
      }
      return new PlamoApiError(`Could not reach the PLaMo API at ${new URL(this.#baseUrl).origin} (${reason}).`, {
        retryable: true,
        unprocessed: NEVER_SENT_CODES.has(code),
        hint: 'Check the network connection and any proxy settings.',
      });
    };

    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'User-Agent': this.#userAgent,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      release();
      throw classify(error);
    }

    if (response.ok) return { response, release, classify };

    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // Keep the status even when the error body cannot be read.
    }
    release();
    if (signal?.aborted) throw abortError();

    const message = this.#redact(extractErrorMessage(bodyText));
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    throw new PlamoApiError(message, {
      status: response.status,
      hint: hintForStatus(response.status, message),
      retryable: RETRYABLE_STATUS.has(response.status) && (retryAfterMs === null || retryAfterMs <= MAX_RETRY_AFTER_MS),
      unprocessed: UNPROCESSED_STATUS.has(response.status),
      retryAfterMs,
    });
  }

  /**
   * Take the API key out of a text that is about to be shown or logged. No
   * message is expected to contain it; this is for the unexpected one, such
   * as a proxy that echoes the request in its error page.
   */
  #redact(text) {
    return this.#apiKey ? text.split(this.#apiKey).join('[API key]') : text;
  }
}
