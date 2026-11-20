// Shared setup for tests that run the real server against the fake API.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FakePlamo, TEST_API_KEY } from './fake-plamo.mjs';
import { McpTestClient } from './mcp-client.mjs';

/**
 * Start a fake PLaMo API, a temporary project directory and the MCP server,
 * and tear all of it down when the test ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {'modern' | 'legacy'} [options.era]
 * @param {Record<string, string | undefined>} [options.env]  Extra environment; `undefined` removes a default.
 * @param {boolean} [options.connect]  Perform the opening handshake. Default true.
 */
export async function startServer(t, { era = 'modern', env = {}, connect = true } = {}) {
  const fake = await FakePlamo.start();
  // realpath: the temporary directory is a symlink on macOS (/var -> /private/var).
  const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-project-')));
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-data-')));

  const fullEnv = {
    PLAMO_API_KEY: TEST_API_KEY,
    PLAMO_BASE_URL: fake.url,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    PLAMO_RETRY_BASE_MS: '5',
    PLAMO_RESEARCH_POLL_MS: '10',
    ...env,
  };
  for (const [key, value] of Object.entries(fullEnv)) {
    if (value === undefined) delete fullEnv[key];
  }

  const client = new McpTestClient({ era, env: fullEnv, cwd: projectDir });
  t.after(async () => {
    await client.close();
    await fake.close();
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (connect) await client.connect();

  const resolve = (relativePath) => path.join(projectDir, relativePath);
  return {
    fake,
    client,
    projectDir,
    dataDir,
    resolve,
    async write(relativePath, content) {
      await fs.mkdir(path.dirname(resolve(relativePath)), { recursive: true });
      await fs.writeFile(resolve(relativePath), content);
      return resolve(relativePath);
    },
    read: (relativePath) => fs.readFile(resolve(relativePath), 'utf8'),
    exists: (relativePath) => fs.access(resolve(relativePath)).then(() => true, () => false),
  };
}

/** The user message of a recorded chat request. */
export function lastUserMessage(request) {
  const messages = request.body.messages;
  return messages[messages.length - 1].content;
}
