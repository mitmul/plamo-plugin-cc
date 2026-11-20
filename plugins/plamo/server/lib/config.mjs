// Runtime configuration for the PLaMo MCP server.
//
// Everything comes from environment variables. Claude Code fills the
// PLAMO_PLUGIN_OPTION_* variables from the plugin's userConfig (see .mcp.json);
// an option the user has not set arrives as an empty string. The remaining
// variables are inherited from the shell that started Claude Code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://api.platform.preferredai.jp/v1';
export const DEFAULT_MODEL = 'plamo-3.1-prime';
export const DEFAULT_DEEP_RESEARCH_MODEL = 'plamo-3.1-prime-deep-research';

/** Largest `max_tokens` the PLaMo chat models accept. */
export const MAX_OUTPUT_TOKENS = 20480;

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Normalise an environment value. Empty strings and placeholders that were
 * never substituted (`${user_config.api_key}`) both mean "not set".
 */
export function cleanEnvValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /^\$\{[^}]*\}$/.test(text)) return '';
  return text;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(cleanEnvValue(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Version of this plugin, read from its manifest so there is one source of truth. */
export function readPluginVersion(pluginRoot = PLUGIN_ROOT) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function normaliseBaseUrl(raw) {
  const candidate = raw || DEFAULT_BASE_URL;
  let url;
  // A value with an "@" may hold a password, so it is never echoed.
  const shown = candidate.includes('@') ? '(value not shown, since it may contain a password)' : candidate;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`PLAMO_BASE_URL is not a valid URL: ${shown}`);
  }
  if (url.username || url.password) {
    throw new Error('PLAMO_BASE_URL must not contain a user name or password (user:password@host): they cannot be sent that way.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PLAMO_BASE_URL must start with https:// or http://, got: ${shown}`);
  }
  return candidate.replace(/\/+$/, '');
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ cwd?: string }} [options]
 */
export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const optionKey = cleanEnvValue(env.PLAMO_PLUGIN_OPTION_API_KEY);
  const envKey = cleanEnvValue(env.PLAMO_API_KEY);
  // The plugin option wins: it is what the user typed into this plugin's own
  // configuration dialog, while PLAMO_API_KEY may be exported for other tools.
  const configuredKey = optionKey || envKey;
  const apiKeySource = optionKey ? 'plugin-option' : envKey ? 'env' : null;
  // A key is one run of printable ASCII. Anything else (a line break from a
  // two-line file, a space, a curly quote from a pasted document) cannot be
  // sent as a header, and the error for it would quote the key. Such a key is
  // not used at all, and is never echoed.
  const apiKeyProblem =
    configuredKey && !/^[\x21-\x7e]+$/.test(configuredKey)
      ? 'The PLaMo API key is set but malformed: it contains whitespace, a line break, or characters outside ASCII. Set it again, as the key alone on one line.'
      : null;
  const apiKey = apiKeyProblem ? '' : configuredKey;

  const projectDir = path.resolve(cleanEnvValue(env.CLAUDE_PROJECT_DIR) || cwd);
  const extraDirs = cleanEnvValue(env.PLAMO_ALLOWED_DIRS)
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.resolve(dir));

  return {
    version: readPluginVersion(),
    apiKey,
    apiKeySource,
    apiKeyProblem,
    baseUrl: normaliseBaseUrl(cleanEnvValue(env.PLAMO_BASE_URL)),
    model: cleanEnvValue(env.PLAMO_PLUGIN_OPTION_MODEL) || cleanEnvValue(env.PLAMO_MODEL) || DEFAULT_MODEL,
    deepResearchModel: cleanEnvValue(env.PLAMO_DEEP_RESEARCH_MODEL) || DEFAULT_DEEP_RESEARCH_MODEL,
    projectDir,
    allowedDirs: [projectDir, ...extraDirs],
    dataDir: cleanEnvValue(env.CLAUDE_PLUGIN_DATA) || null,
    debug: /^(1|true|yes|on)$/i.test(cleanEnvValue(env.PLAMO_DEBUG)),
    // Tuning knobs, mostly useful for tests.
    maxRetries: positiveInt(env.PLAMO_MAX_RETRIES, 2),
    retryBaseMs: positiveInt(env.PLAMO_RETRY_BASE_MS, 1000),
    requestTimeoutMs: positiveInt(env.PLAMO_REQUEST_TIMEOUT_MS, 10 * 60 * 1000),
    // Size of the parts a document is translated in. Smaller parts are translated more accurately.
    translateChunkChars: Math.max(200, positiveInt(env.PLAMO_TRANSLATE_CHUNK_CHARS, 2000)),
    researchPollMs: positiveInt(env.PLAMO_RESEARCH_POLL_MS, 5000),
    researchWaitMs: positiveInt(env.PLAMO_RESEARCH_WAIT_MS, 30 * 60 * 1000),
  };
}
