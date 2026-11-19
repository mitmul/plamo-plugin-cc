// A small MCP client that drives the real server process over stdio.
//
// Tests and the live check talk to the server exactly as Claude Code does:
// newline-delimited JSON-RPC, either with the `initialize` handshake ("legacy")
// or with per-request protocol metadata ("modern", MCP 2026-07-28).

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'plamo');
export const SERVER_ENTRY = path.join(PLUGIN_ROOT, 'server', 'index.mjs');

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

export class McpTestClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #era;
  /** Every notification the server sent, in order. */
  notifications = [];
  /** Lines the server wrote to stdout that were not valid JSON. There must be none. */
  garbage = [];
  stderr = '';

  /**
   * @param {object} [options]
   * @param {'modern' | 'legacy'} [options.era]
   * @param {Record<string, string>} [options.env]  Replaces the inherited environment except PATH and HOME.
   * @param {string} [options.cwd]
   */
  constructor({ era = 'modern', env = {}, cwd = REPO_ROOT } = {}) {
    this.#era = era;
    // A clean environment keeps a developer's own PLAMO_* variables out of the tests.
    const baseEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    this.#child = spawn(process.execPath, [SERVER_ENTRY], { cwd, env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise((resolve) => this.#child.on('exit', (code, signal) => resolve({ code, signal })));
    this.#child.stderr.setEncoding('utf8').on('data', (chunk) => {
      this.stderr += chunk;
    });
    readline.createInterface({ input: this.#child.stdout }).on('line', (line) => this.#onLine(line));
    this.exited.then(() => {
      for (const { reject } of this.#pending.values()) reject(new Error(`server exited before answering; stderr: ${this.stderr}`));
      this.#pending.clear();
    });
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.garbage.push(line);
      return;
    }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const { resolve } = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      resolve(message);
    } else {
      this.notifications.push(message);
    }
  }

  /** Write a raw line to the server's stdin. */
  sendRaw(line) {
    this.#child.stdin.write(`${line}\n`);
  }

  /**
   * Send a request and resolve with the full JSON-RPC response (result or error).
   * In the modern era the protocol metadata is added to `params._meta`.
   */
  request(method, params = undefined, { id = this.#nextId++, meta = {}, raw = false } = {}) {
    let finalParams = params;
    if (!raw && this.#era === 'modern') {
      finalParams = { ...(params ?? {}), _meta: { ...MODERN_META, ...meta } };
    } else if (Object.keys(meta).length > 0) {
      finalParams = { ...(params ?? {}), _meta: meta };
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(finalParams === undefined ? {} : { params: finalParams }) }));
    });
  }

  notify(method, params = undefined) {
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  /** Open the connection the way a client of this era does. */
  async connect() {
    if (this.#era === 'legacy') {
      const response = await this.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      });
      this.notify('notifications/initialized');
      return response;
    }
    return this.request('server/discover');
  }

  /**
   * Call a tool and return its result with the text blocks joined.
   * @returns {Promise<{ text: string, isError: boolean, result: object, progress: string[], response: object }>}
   */
  async callTool(name, args = {}, { progressToken = undefined } = {}) {
    const before = this.notifications.length;
    const response = await this.request('tools/call', { name, arguments: args }, { meta: progressToken === undefined ? {} : { progressToken } });
    if (response.error) throw Object.assign(new Error(`tools/call failed: ${response.error.message}`), { response });
    const result = response.result;
    const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const progress = this.notifications
      .slice(before)
      .filter((message) => message.method === 'notifications/progress' && message.params?.progressToken === progressToken)
      .map((message) => message.params.message);
    return { text, isError: Boolean(result.isError), result, progress, response };
  }

  /** Close stdin, which asks the server to exit, and wait for it. */
  async close() {
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 3000);
    const exit = await this.exited;
    clearTimeout(timer);
    return exit;
  }

  kill(signal = 'SIGINT') {
    this.#child.kill(signal);
  }
}
