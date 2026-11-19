#!/usr/bin/env node
// PLaMo MCP server: gives Claude Code tools that call the PLaMo API.
//
// Started by Claude Code over stdio (see ../.mcp.json). It has no dependencies
// beyond Node.js 18 or later. Protocol messages go to stdout, one JSON object
// per line; everything else is logged to stderr.

import readline from 'node:readline';

import { loadConfig } from './lib/config.mjs';
import { createFileAccess } from './lib/files.mjs';
import { McpServer } from './lib/mcp.mjs';
import { PlamoClient } from './lib/plamo-client.mjs';
import { ConversationStore, ResearchJobStore } from './lib/state.mjs';
import { createTools } from './lib/tools/index.mjs';

const INSTRUCTIONS = `PLaMo is the Japanese-focused LLM built by Preferred Networks. These tools call it on the user's behalf.

When to use them: only when the user asks for PLaMo, by name ("PLaMoに聞いて", "PLaMoで翻訳して", "ask PLaMo") or through a /plamo:* command. Do not call them on your own initiative: every call spends the user's PLaMo quota and sends its input to the PLaMo API.

Tools: chat (ask, write, rewrite, proofread), web_search (an answer with web sources), translate (texts and whole files), deep_research_start / deep_research_get / deep_research_cancel (long research reports), count_tokens, and status (configuration check).

Using them well:
- PLaMo cannot see this conversation or the workspace. Put the full context into the prompt, or attach files by path.
- For files, pass paths (files, input_file, output_file) rather than pasting contents: the server reads and writes inside the project directory itself.
- Relay PLaMo's answer faithfully and say that it comes from PLaMo. Keep your own comments clearly separate from it.
- Never send secrets, credentials or personal data. On PLaMo's Free plan, inputs and outputs are stored and used for training. web_search and Deep Research send search queries to an external search service and are billed per search.
- If a tool reports a missing or rejected API key, tell the user to run /plamo:setup.`;

function log(text) {
  process.stderr.write(`[plamo] ${text}\n`);
}

function main() {
  if (typeof globalThis.fetch !== 'function') {
    log(`Node.js 18 or later is required (found ${process.versions.node}).`);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log(`Invalid configuration: ${error.message}`);
    process.exit(1);
  }
  const debug = config.debug ? log : () => {};

  const client = new PlamoClient({
    apiKey: config.apiKey,
    keyProblem: config.apiKeyProblem,
    baseUrl: config.baseUrl,
    userAgent: `plamo-plugin-cc/${config.version} (Claude Code plugin; +https://github.com/mitmul/plamo-plugin-cc)`,
    maxRetries: config.maxRetries,
    retryBaseMs: config.retryBaseMs,
    requestTimeoutMs: config.requestTimeoutMs,
    log,
  });
  const tools = createTools({
    client,
    config,
    files: createFileAccess({ projectDir: config.projectDir, allowedDirs: config.allowedDirs }),
    conversations: new ConversationStore(),
    jobs: new ResearchJobStore({ dataDir: config.dataDir, projectDir: config.projectDir }),
  });

  // If the client goes away, writes fail with EPIPE; there is nobody left to serve.
  process.stdout.on('error', () => process.exit(0));
  const server = new McpServer({
    serverInfo: { name: 'plamo', title: 'PLaMo', version: config.version },
    instructions: INSTRUCTIONS,
    tools,
    write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    log,
  });

  debug(`started: version ${config.version}, model ${config.model}, endpoint ${config.baseUrl}, API key ${config.apiKeySource ?? 'not configured'}`);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (config.debug) debug(`received ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
    // Requests are handled concurrently: a long tool call must not hold up a cancellation or another call.
    server.handleLine(line).catch((error) => log(`unhandled error: ${error?.stack ?? error}`));
  });
  lines.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
