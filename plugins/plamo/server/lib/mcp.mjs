// Minimal Model Context Protocol server over newline-delimited JSON-RPC.
//
// It is "dual-era" in the sense of the MCP 2026-07-28 specification:
//
//   * Modern clients put the protocol version in every request's `_meta` and
//     start with `server/discover`. Each request is served statelessly.
//   * Legacy clients open with an `initialize` handshake (2025-11-25 and
//     earlier).
//
// Claude Code probes a stdio server with `server/discover` and falls back to
// `initialize` when the probe is rejected, so supporting both keeps the server
// usable from old and new clients alike. Only the tools capability is
// implemented; this server never sends requests to the client.

import { validateArgs } from './schema.mjs';

export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'];
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const ErrorCode = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  UnsupportedProtocolVersion: -32022,
});

/** How long a client may cache the tool list. It only changes with the plugin version. */
const TOOL_LIST_TTL_MS = 5 * 60 * 1000;

/** Minimum gap between two progress notifications of one request. */
const PROGRESS_INTERVAL_MS = 750;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Returned by a handler path whose request was cancelled: no response is sent. */
const CANCELLED = Symbol('cancelled');

/**
 * @typedef {object} ToolContext
 * @property {AbortSignal} signal  Aborted when the client cancels the call.
 * @property {(message: string, options?: { force?: boolean }) => void} progress
 *   Report a human-readable status line; a no-op when the client did not ask for progress.
 *
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} [title]
 * @property {string} description
 * @property {object} inputSchema
 * @property {object} [annotations]
 * @property {(args: Record<string, any>, ctx: ToolContext) => Promise<string | { text?: string, content?: object[], isError?: boolean }>} handler
 */

export class McpServer {
  #serverInfo;
  #instructions;
  #tools = new Map();
  #write;
  #log;
  /** Abort controllers of the tool calls in progress, by request id. */
  #inflight = new Map();

  /**
   * @param {object} options
   * @param {{ name: string, version: string, title?: string }} options.serverInfo
   * @param {string} [options.instructions]
   * @param {Tool[]} options.tools
   * @param {(message: object) => void} options.write  Sends one JSON-RPC message to the client.
   * @param {(text: string) => void} [options.log]
   */
  constructor({ serverInfo, instructions, tools, write, log = () => {} }) {
    this.#serverInfo = serverInfo;
    this.#instructions = instructions;
    for (const tool of tools) this.#tools.set(tool.name, tool);
    this.#write = write;
    this.#log = log;
  }

  /** Abort every tool call that is still running (used at shutdown). */
  close() {
    for (const controller of this.#inflight.values()) controller.abort();
    this.#inflight.clear();
  }

  /** Handle one line received from the client. Never rejects. */
  async handleLine(line) {
    const text = line.trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.#sendError(null, ErrorCode.ParseError, 'Parse error: the line is not valid JSON');
      return;
    }

    if (Array.isArray(message)) {
      this.#sendError(null, ErrorCode.InvalidRequest, 'JSON-RPC batches are not supported');
      return;
    }
    if (message === null || typeof message !== 'object') {
      this.#sendError(null, ErrorCode.InvalidRequest, 'Invalid request');
      return;
    }
    // A message without a method is a response; this server sends no requests.
    if (typeof message.method !== 'string') return;

    const hasId = typeof message.id === 'string' || typeof message.id === 'number';
    if (!hasId) {
      this.#handleNotification(message);
      return;
    }
    await this.#handleRequest(message);
  }

  #handleNotification({ method, params }) {
    if (method === 'notifications/cancelled') {
      const controller = this.#inflight.get(params?.requestId);
      if (controller) {
        this.#log(`request ${params.requestId} cancelled by client`);
        controller.abort();
      }
    }
    // notifications/initialized and anything unknown need no action.
  }

  async #handleRequest({ id, method, params }) {
    const requestParams = params !== null && typeof params === 'object' ? params : {};
    const requestedVersion = requestParams._meta?.[META_PROTOCOL_VERSION];
    const isModern = requestedVersion !== undefined;

    if (isModern && !MODERN_PROTOCOL_VERSIONS.includes(requestedVersion)) {
      this.#sendError(id, ErrorCode.UnsupportedProtocolVersion, 'Unsupported protocol version', {
        supported: MODERN_PROTOCOL_VERSIONS,
        requested: requestedVersion,
      });
      return;
    }

    try {
      const result = isModern
        ? await this.#routeModern(id, method, requestParams)
        : await this.#routeLegacy(id, method, requestParams);
      if (result === CANCELLED) return;
      this.#write({ jsonrpc: '2.0', id, result: isModern ? this.#asModernResult(result) : result });
    } catch (error) {
      if (error instanceof RpcError) {
        this.#sendError(id, error.code, error.message, error.data);
      } else {
        this.#log(`internal error while handling ${method}: ${error?.stack ?? error}`);
        this.#sendError(id, ErrorCode.InternalError, `Internal error: ${error?.message ?? error}`);
      }
    }
  }

  #routeLegacy(id, method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        return {
          // Echo a version we know; otherwise offer our newest and let the client decide.
          protocolVersion: LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: this.#serverInfo,
          ...(this.#instructions ? { instructions: this.#instructions } : {}),
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.#listTools() };
      case 'tools/call':
        return this.#callTool(id, params);
      case 'server/discover':
        throw new RpcError(ErrorCode.InvalidParams, `server/discover requires _meta["${META_PROTOCOL_VERSION}"]`);
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  #routeModern(id, method, params) {
    switch (method) {
      case 'server/discover':
        return {
          supportedVersions: MODERN_PROTOCOL_VERSIONS,
          capabilities: { tools: {} },
          ...(this.#instructions ? { instructions: this.#instructions } : {}),
          ttlMs: TOOL_LIST_TTL_MS,
          cacheScope: 'public',
        };
      case 'tools/list':
        return { tools: this.#listTools(), ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'public' };
      case 'tools/call':
        return this.#callTool(id, params);
      case 'initialize':
        throw new RpcError(
          ErrorCode.MethodNotFound,
          `Method not found: initialize is not part of protocol ${MODERN_PROTOCOL_VERSIONS[0]}. Send requests directly, or omit the protocol version from _meta to use the handshake of ${LEGACY_PROTOCOL_VERSIONS.join(', ')}.`,
        );
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  #asModernResult(result) {
    return {
      resultType: 'complete',
      ...result,
      _meta: { ...result._meta, [META_SERVER_INFO]: this.#serverInfo },
    };
  }

  #listTools() {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }));
  }

  async #callTool(id, params) {
    const tool = this.#tools.get(params.name);
    if (!tool) throw new RpcError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);

    // Bad arguments are reported as a tool error rather than a protocol error
    // so that the model sees the message and can correct the call.
    const { value: args, errors } = validateArgs(tool.inputSchema, params.arguments);
    if (errors.length > 0) {
      return toolResult({ text: `Invalid arguments for ${tool.name}: ${errors.join('; ')}.`, isError: true });
    }

    const controller = new AbortController();
    this.#inflight.set(id, controller);
    const context = { signal: controller.signal, progress: this.#progressReporter(params._meta?.progressToken, controller.signal) };

    try {
      const output = await tool.handler(args, context);
      if (controller.signal.aborted) return CANCELLED;
      return toolResult(typeof output === 'string' ? { text: output } : output);
    } catch (error) {
      if (controller.signal.aborted) return CANCELLED;
      // An error that knows how to describe itself is an expected failure; anything else is a bug worth a stack trace.
      const expected = typeof error?.toToolMessage === 'function';
      this.#log(expected ? `tool ${tool.name}: ${error.message}` : `tool ${tool.name} failed unexpectedly: ${error?.stack ?? error}`);
      return toolResult({ text: expected ? error.toToolMessage() : `Error: ${error?.message ?? String(error)}`, isError: true });
    } finally {
      this.#inflight.delete(id);
      // Whatever the call left running stops with it: a parallel request of a
      // handler that failed must not go on spending, nor report progress on a
      // call that has been answered.
      controller.abort();
    }
  }

  #progressReporter(progressToken, signal) {
    if (progressToken === undefined || progressToken === null) return () => {};
    let step = 0;
    let lastSentAt = 0;
    return (message, { force = false } = {}) => {
      if (signal.aborted) return;
      const now = Date.now();
      if (!force && now - lastSentAt < PROGRESS_INTERVAL_MS) return;
      lastSentAt = now;
      step += 1;
      this.#write({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken, progress: step, message: String(message) },
      });
    };
  }

  #sendError(id, code, message, data) {
    // MCP makes `id` optional on an error whose request id could not be read
    // (a malformed line), so it is left out rather than sent as null.
    this.#write({
      jsonrpc: '2.0',
      ...(id === null || id === undefined ? {} : { id }),
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }
}

function toolResult({ text, content, isError = false }) {
  const blocks = Array.isArray(content) && content.length > 0 ? content : [{ type: 'text', text: String(text ?? '') }];
  return { content: blocks, isError: Boolean(isError) };
}
