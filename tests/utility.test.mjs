// The status and count_tokens tools.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lastUserMessage, startServer } from './helpers/harness.mjs';

test('status reports a working setup without revealing the key', async (t) => {
  const { client, fake, projectDir } = await startServer(t);
  const { text, isError } = await client.callTool('status');

  assert.equal(isError, false);
  assert.match(text, /^PLaMo plugin \d+\.\d+\.\d+ \(Node\.js \d+\./);
  assert.ok(text.includes(`- API endpoint: ${fake.url}`));
  assert.ok(text.includes('- API key: configured (PLAMO_API_KEY environment variable)'));
  assert.ok(text.includes('- Model: plamo-3.1-prime (Deep Research: plamo-3.1-prime-deep-research)'));
  assert.ok(text.includes(projectDir));
  assert.ok(text.includes('- Connection: OK, the API key is valid (3 models available: plamo-3.0-prime, plamo-3.0-fin-beta, plamo-3.1-prime)'));
  assert.match(text, /Ready\. Try \/plamo:ask/);
  assert.doesNotMatch(text, /test-key/);
  assert.deepEqual(fake.requests.map((request) => `${request.method} ${request.path}`), ['GET /v1/models'], 'only the free models endpoint is called');
});

test('status names the plugin option as the source of the key', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_API_KEY: undefined, PLAMO_PLUGIN_OPTION_API_KEY: 'test-key' } });
  const { text } = await client.callTool('status');
  assert.ok(text.includes('- API key: configured (plugin option "PLaMo API key")'));
});

test('status explains how to set a missing key', async (t) => {
  const { client, fake } = await startServer(t, { env: { PLAMO_API_KEY: undefined, PLAMO_PLUGIN_OPTION_API_KEY: '' } });
  const { text, isError } = await client.callTool('status');

  assert.equal(isError, true);
  assert.ok(text.includes('- API key: NOT CONFIGURED'));
  assert.match(text, /How to set the API key:/);
  assert.match(text, /https:\/\/console\.platform\.preferredai\.jp\/profile/);
  assert.match(text, /export PLAMO_API_KEY=<key>/);
  assert.equal(fake.requests.length, 0);
});

test('status reports a rejected key', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_API_KEY: 'wrong-key' } });
  const { text, isError } = await client.callTool('status');

  assert.equal(isError, true);
  assert.match(text, /- Connection: FAILED\. PLaMo API error \(HTTP 401\): Unauthorized/);
  assert.match(text, /How to set the API key:/);
  assert.doesNotMatch(text, /wrong-key/);
});

test('status warns when the configured model does not exist', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_MODEL: 'plamo-4-ultra' } });
  const { text, isError } = await client.callTool('status');
  assert.equal(isError, true);
  assert.match(text, /WARNING: the configured model "plamo-4-ultra" is not in that list/);
});

test('status reports an unreachable API', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_BASE_URL: 'http://127.0.0.1:9/v1', PLAMO_MAX_RETRIES: '0' } });
  const { text, isError } = await client.callTool('status');
  assert.equal(isError, true);
  assert.match(text, /- Connection: FAILED\. PLaMo error: Could not reach the PLaMo API at http:\/\/127\.0\.0\.1:9/);
});

test('status explains an answer that is not from the API', async (t) => {
  const { client, fake } = await startServer(t);
  fake.failNext(1, 200, '<html><body>Sign in to the corporate proxy</body></html>');
  const { text, isError } = await client.callTool('status');
  assert.equal(isError, true);
  assert.match(text, /Connection: FAILED\. PLaMo error: The API answered with something that is not JSON\.\n {2}Check PLAMO_BASE_URL and any proxy/);
  assert.equal(fake.requests.length, 1, 'a wrong endpoint is not retried');
});

test('an HTML error page from a gateway is reported with its status', async (t) => {
  const { client, fake } = await startServer(t, { env: { PLAMO_MAX_RETRIES: '0' } });
  fake.failNext(1, 502, '<html><body><h1>502 Bad Gateway</h1></body></html>');
  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, true);
  assert.match(text, /^PLaMo API error \(HTTP 502\): <html><body><h1>502 Bad Gateway<\/h1><\/body><\/html>\nThe PLaMo API is temporarily unavailable/);
});

test('count_tokens counts text and files against the context window', async (t) => {
  const { client, fake, write } = await startServer(t);
  await write('a.txt', 'こんにちは');
  fake.onTokenize(() => 26214);

  const { text, isError } = await client.callTool('count_tokens', { text: '前置き', files: ['a.txt'] });

  assert.equal(isError, false);
  assert.match(text, /^26214 tokens \(10\.0% of the 262144-token context window of plamo-3\.1-prime\), for \d+ characters\.\nFiles counted: a\.txt \(5 chars\)\./);
  const [{ body }] = fake.requests;
  assert.equal(body.model, 'plamo-3.1-prime');
  assert.ok(body.prompt.startsWith('前置き\n\n--- Attached files (1) ---'), 'files are counted as the chat tool would attach them');
});

test('count_tokens counts exactly what chat would send for the same files', async (t) => {
  const { client, fake, write } = await startServer(t);
  await write('a.txt', 'alpha');
  await client.callTool('count_tokens', { text: 'p', files: ['a.txt'] });
  await client.callTool('chat', { prompt: 'p', files: ['a.txt'] });
  assert.equal(fake.requests[0].body.prompt, lastUserMessage(fake.requests[1]));
});

test('count_tokens needs something to count', async (t) => {
  const { client } = await startServer(t);
  const { text, isError } = await client.callTool('count_tokens', {});
  assert.equal(isError, true);
  assert.match(text, /Give `text`, `files`, or both/);
});
