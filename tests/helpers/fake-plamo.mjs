// A scriptable stand-in for the PLaMo API, for tests.
//
// It speaks the parts of the API the plugin uses, with the response shapes
// observed on the real service: streamed and plain chat completions, the
// tokenizer, the model list, and Deep Research jobs with polling, an event
// stream and cancellation.

import http from 'node:http';

export const TEST_API_KEY = 'test-key';
export const CONTEXT_LENGTH = 262144;

const DEFAULT_MODELS = ['plamo-3.0-prime', 'plamo-3.0-fin-beta', 'plamo-3.1-prime'];

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function completionId() {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

function usageFor(reply) {
  const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, completion_tokens_details: { reasoning_tokens: 0 }, ...reply.usage };
  const details = reply.usageDetails ?? [
    { model: 'plamo-3.1-prime', usage_type: 'main_response', input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, token_consumed: usage.total_tokens },
    ...(reply.webSearches ? [{ model: 'web_search_basic', usage_type: 'web_search', input_tokens: reply.webSearches, output_tokens: 0, token_consumed: reply.webSearches }] : []),
    { model: 'plamo-guardrail', usage_type: 'input_guardrail', input_tokens: 600, output_tokens: 1, token_consumed: 601 },
  ];
  return { usage, plamo_usage_details: details };
}

function wait(ms) {
  // unref: a reply that is still being delayed must not keep a finished test run alive.
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export const REPORT_TEXT = '# 調査レポート\n\n日本ではAI事業者ガイドラインが整備されました。 法制化の議論も進んでいます。\n';

/**
 * Output of a finished Deep Research job, shaped like the real thing: the
 * citations are flat, zero-width, placed right after a sentence, and the
 * first one is listed twice.
 */
export function defaultReportOutput() {
  const points = Array.from(REPORT_TEXT);
  const afterFirstSentence = points.indexOf('。') + 1;
  const afterSecondSentence = points.lastIndexOf('。') + 1;
  const government = { type: 'url_citation', url: 'https://example.go.jp/ai', title: 'AI 政策の概要' };
  return [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '調査計画を立てています。' }] },
    { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: '生成AI 規制 日本', queries: ['生成AI 規制 日本'] } },
    { type: 'web_search_call', id: 'ws_2', status: 'completed', action: { type: 'open_page', url: 'https://example.go.jp/ai', title: 'AI 政策の概要' } },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: REPORT_TEXT,
          annotations: [
            { ...government, start_index: afterFirstSentence, end_index: afterFirstSentence },
            { ...government, start_index: afterFirstSentence, end_index: afterFirstSentence },
            { type: 'url_citation', url: 'https://example.com/news', title: 'ニュース', start_index: afterSecondSentence, end_index: afterSecondSentence },
          ],
        },
      ],
    },
    { type: 'web_search_call', id: 'ws_3', status: 'completed', action: { type: 'search', query: '後続の検索', queries: ['後続の検索'] } },
  ];
}

/**
 * @typedef {object} ChatReply
 * @property {string} [content]
 * @property {string} [finishReason]  Default "stop".
 * @property {object[]} [annotations]  url_citation annotations, nested as in Chat Completions.
 * @property {object} [usage]  Overrides for the usage object.
 * @property {number} [webSearches]
 * @property {number} [status]  Answer with this HTTP status instead of a completion.
 * @property {object} [errorBody]
 * @property {Record<string, string>} [headers]
 * @property {number} [delayMs]  Wait before the first byte.
 * @property {boolean} [json]  Answer with plain JSON even if a stream was requested.
 * @property {number} [dropAfterChunks]  Close the connection after this many content chunks.
 * @property {object} [streamError]  Send this object as an event after the first content chunk, then end the stream.
 */

export class FakePlamo {
  /** Every request received: { method, path, query, headers, body }. */
  requests = [];
  models = [...DEFAULT_MODELS];
  /** Pieces a streamed answer is cut into. */
  streamPieces = 3;
  #server;
  #chatHandler = (body) => ({ content: `echo: ${body.messages[body.messages.length - 1].content}` });
  #tokenCounter = (body) => Math.ceil((body.prompt ?? JSON.stringify(body.messages)).length / 2);
  #failures = [];
  #jobs = new Map();
  #sockets = new Set();

  static async start() {
    const fake = new FakePlamo();
    fake.#server = http.createServer((request, response) => {
      fake.#handle(request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { detail: `fake server error: ${error.message}` });
        else response.destroy();
      });
    });
    fake.#server.on('connection', (socket) => {
      fake.#sockets.add(socket);
      socket.on('close', () => fake.#sockets.delete(socket));
    });
    await new Promise((resolve) => fake.#server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  /** Base URL to put into PLAMO_BASE_URL. */
  get url() {
    return `http://127.0.0.1:${this.#server.address().port}/v1`;
  }

  async close() {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  /** @param {(body: object, request: object) => ChatReply | Promise<ChatReply>} handler */
  onChat(handler) {
    this.#chatHandler = handler;
  }

  /** @param {(body: object) => number} counter */
  onTokenize(counter) {
    this.#tokenCounter = counter;
  }

  /** Make the next `count` requests whose path starts with `pathPrefix` fail. */
  failNext(count, status, body = { detail: 'scripted failure' }, { pathPrefix = '/v1/', headers = {} } = {}) {
    this.#failures.push({ remaining: count, status, body, pathPrefix, headers });
  }

  chatRequests() {
    return this.requests.filter((request) => request.path === '/v1/chat/completions');
  }

  /**
   * Describe how the next Deep Research job behaves.
   * @param {object} script
   * @param {number} [script.pollsUntilDone]  How many GETs report "in_progress" before the final state.
   * @param {string} [script.finalStatus]  Default "completed".
   * @param {object[]} [script.output]  Output items of the finished response.
   * @param {object} [script.error]
   * @param {object[]} [script.events]  Extra stream events sent before the terminal one.
   * @param {boolean} [script.streamUnavailable]  Answer stream requests with 500.
   * @param {boolean} [script.streamEndsEarly]  Close the stream before the terminal event.
   */
  scriptJob(script = {}) {
    this.nextJob = script;
  }

  job(id) {
    return this.#jobs.get(id);
  }

  /** How many Deep Research jobs have been started. */
  get jobCount() {
    return this.#jobs.size;
  }

  #jobResponse(job, status = job.status) {
    const finished = ['completed', 'incomplete'].includes(status);
    return {
      id: job.id,
      object: 'response',
      created_at: job.createdAt,
      status,
      background: true,
      model: job.request.model,
      output: finished ? job.output : [],
      usage: finished ? { input_tokens: 24282, output_tokens: 3892, total_tokens: 28174 } : null,
      tool_usage: finished ? { web_search: { num_requests: 4 } } : null,
      error: status === 'failed' ? (job.error ?? { code: 'timeout', message: 'The job timed out' }) : null,
      tools: [{ type: 'web_search' }],
      max_tool_calls: job.request.max_tool_calls ?? 100,
      incomplete_details: null,
    };
  }

  async #handle(request, response) {
    const url = new URL(request.url, 'http://fake');
    const rawBody = await readBody(request);
    let body = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const record = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, body };
    this.requests.push(record);

    if (request.headers.authorization === undefined) return sendJson(response, 400, { message: 'missing key in request header' });
    if (request.headers.authorization !== `Bearer ${TEST_API_KEY}`) return sendJson(response, 401, { message: 'Unauthorized' });

    const failure = this.#failures.find((candidate) => candidate.remaining > 0 && url.pathname.startsWith(candidate.pathPrefix));
    if (failure) {
      failure.remaining -= 1;
      // A string body is sent as it is, to imitate a proxy answering with HTML.
      if (typeof failure.body === 'string') {
        response.writeHead(failure.status, { 'content-type': 'text/html', ...failure.headers });
        return response.end(failure.body);
      }
      return sendJson(response, failure.status, failure.body, failure.headers);
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(response, 200, {
        object: 'list',
        data: this.models.map((id) => ({ id, object: 'model', created: 1789084800, owned_by: 'system', max_model_len: CONTEXT_LENGTH })),
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/tokenize') {
      return sendJson(response, 200, { count: this.#tokenCounter(body), max_model_len: CONTEXT_LENGTH, tokens: [] });
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') return this.#chat(body, record, response);
    if (url.pathname === '/v1/responses' && request.method === 'POST') return this.#createJob(body, response);

    const jobMatch = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (jobMatch) {
      const job = this.#jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) return sendJson(response, 404, { code: 'not_found', message: 'Response not found', details: [] });
      if (jobMatch[2] && request.method === 'POST') {
        if (!['completed', 'incomplete', 'failed'].includes(job.status)) job.status = 'cancelled';
        return sendJson(response, 200, this.#jobResponse(job));
      }
      if (request.method === 'GET' && url.searchParams.get('stream') === 'true') return this.#streamJob(job, url, response);
      if (request.method === 'GET') {
        if (job.status === 'in_progress' || job.status === 'queued') {
          job.polls += 1;
          job.status = job.polls > job.script.pollsUntilDone ? job.script.finalStatus : 'in_progress';
        }
        return sendJson(response, 200, this.#jobResponse(job));
      }
    }
    return sendJson(response, 404, { detail: 'Not Found' });
  }

  async #chat(body, record, response) {
    if (!this.models.includes(body.model)) return sendJson(response, 404, { detail: 'model not found' });
    if (body.max_tokens > 20480) return sendJson(response, 400, { detail: 'max_completion_tokens must be less than or equal to 20480' });
    if (body.web_search_options && body.temperature !== undefined) {
      return sendJson(response, 400, { detail: 'Model incompatible request argument supplied: temperature' });
    }

    const reply = await this.#chatHandler(body, record);
    if (reply.delayMs) await wait(reply.delayMs);
    if (response.destroyed) return undefined;
    if (reply.status) return sendJson(response, reply.status, reply.errorBody ?? { detail: 'scripted error' }, reply.headers);

    const id = completionId();
    const content = reply.content ?? '';
    const finishReason = reply.finishReason ?? 'stop';
    const base = { id, created: 1795066591, model: body.model };

    if (!body.stream || reply.json) {
      return sendJson(response, 200, {
        ...base,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: finishReason,
            logprobs: null,
            message: { role: 'assistant', content, tool_calls: null, annotations: reply.annotations ?? null, reasoning: null },
            stop_reason: 16,
            reasoning_summary: null,
          },
        ],
        ...usageFor(reply),
      });
    }

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const emit = (choices, extra = {}) =>
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, usage: null, plamo_usage_details: null, ...extra })}\n\n`);
    const choice = (delta, extra = {}) => [{ index: 0, finish_reason: null, logprobs: null, delta: { content: null, role: null, tool_calls: null, annotations: null, reasoning: null, ...delta }, stop_reason: null, reasoning_summary: null, ...extra }];

    emit(choice({ content: '', role: 'assistant' }));
    const points = Array.from(content);
    const size = Math.max(1, Math.ceil(points.length / this.streamPieces));
    let sent = 0;
    for (let start = 0; start < points.length; start += size) {
      if (reply.dropAfterChunks !== undefined && sent >= reply.dropAfterChunks) {
        // Let what was written reach the client first: the point is a stream that starts and then breaks.
        await wait(20);
        response.destroy();
        return undefined;
      }
      emit(choice({ content: points.slice(start, start + size).join('') }));
      sent += 1;
      if (reply.streamError) {
        response.end(`data: ${JSON.stringify(reply.streamError)}\n\n`);
        return undefined;
      }
    }
    if (reply.dropAfterChunks !== undefined && sent >= reply.dropAfterChunks) {
      await wait(20);
      response.destroy();
      return undefined;
    }
    emit(choice({ content: '', annotations: reply.annotations ?? null }, { finish_reason: finishReason }));
    if (body.stream_options?.include_usage) emit([], usageFor(reply));
    response.end('data: [DONE]\n\n');
    return undefined;
  }

  #createJob(body, response) {
    if (body?.background !== true) return sendJson(response, 400, { code: 'invalid_request', message: 'background=true is required for deep research', details: [] });
    const script = { pollsUntilDone: 0, finalStatus: 'completed', events: [], ...this.nextJob };
    this.nextJob = undefined;
    const id = `resp_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}${String(this.#jobs.size).padStart(4, '0')}`;
    const job = {
      id,
      request: body,
      script,
      status: 'queued',
      polls: 0,
      createdAt: Math.floor(Date.now() / 1000),
      error: script.error,
      output: script.output ?? defaultReportOutput(),
    };
    this.#jobs.set(id, job);
    return sendJson(response, 200, this.#jobResponse(job));
  }

  async #streamJob(job, url, response) {
    if (job.script.streamUnavailable) return sendJson(response, 500, { detail: 'stream unavailable' });
    const startingAfter = url.searchParams.has('starting_after') ? Number(url.searchParams.get('starting_after')) : -1;
    job.streamRequests = (job.streamRequests ?? 0) + 1;

    const events = [
      { type: 'response.queued', response: this.#jobResponse(job, 'queued') },
      { type: 'response.in_progress', response: this.#jobResponse(job, 'in_progress') },
      ...job.output.map((item, index) => ({ type: 'response.output_item.added', output_index: index, item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : item })),
      ...job.script.events,
    ].map((event, index) => ({ ...event, sequence_number: index }));

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(': open\n\n');
    for (const event of events) {
      if (event.sequence_number <= startingAfter) continue;
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    // The first stream may break off before the job ends, to exercise resuming.
    if (job.script.streamEndsEarly && job.streamRequests === 1) {
      response.end();
      return undefined;
    }
    if (job.status === 'queued' || job.status === 'in_progress') job.status = job.script.finalStatus;
    const terminal = { type: `response.${job.status}`, response: this.#jobResponse(job), sequence_number: events.length };
    response.end(`event: ${terminal.type}\ndata: ${JSON.stringify(terminal)}\n\n`);
    return undefined;
  }
}
