// The MCP wire protocol, exercised against the real server process.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startServer } from './helpers/harness.mjs';

const TOOL_NAMES = ['chat', 'web_search', 'translate', 'deep_research_start', 'deep_research_get', 'deep_research_cancel', 'count_tokens', 'status'];
const MODERN_VERSION = '2026-07-28';

test('legacy clients get the initialize handshake', async (t) => {
  const { client } = await startServer(t, { era: 'legacy', connect: false });
  const response = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });

  assert.equal(response.result.protocolVersion, '2025-06-18', 'a known version is echoed back');
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, 'plamo');
  assert.match(response.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.match(response.result.instructions, /PLaMo/);
  assert.equal(response.result.resultType, undefined, 'legacy results carry no resultType');
});

test('an unknown legacy protocol version is answered with the newest one the server knows', async (t) => {
  const { client } = await startServer(t, { era: 'legacy', connect: false });
  const response = await client.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(response.result.protocolVersion, '2025-11-25');
});

test('modern clients discover the server without a handshake', async (t) => {
  const { client } = await startServer(t, { connect: false });
  const response = await client.request('server/discover', undefined, { id: 'server-discover-probe-1' });

  assert.equal(response.id, 'server-discover-probe-1');
  assert.equal(response.result.resultType, 'complete');
  assert.deepEqual(response.result.supportedVersions, [MODERN_VERSION]);
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.match(response.result.instructions, /PLaMo/);
  assert.equal(typeof response.result.ttlMs, 'number');
  assert.equal(response.result.cacheScope, 'public');
  assert.equal(response.result._meta['io.modelcontextprotocol/serverInfo'].name, 'plamo');
});

for (const era of ['legacy', 'modern']) {
  test(`tools/list returns every tool with a valid schema (${era})`, async (t) => {
    const { client } = await startServer(t, { era });
    const { result } = await client.request('tools/list');

    assert.deepEqual(result.tools.map((tool) => tool.name), TOOL_NAMES);
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has an object schema`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown parameters`);
      assert.ok(tool.description.length > 40 && tool.description.length < 2000, `${tool.name} has a usable description`);
      for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
        assert.match(name, /^[A-Za-z0-9_.-]{1,64}$/, `${tool.name}.${name} is a property name the Claude API accepts`);
        assert.ok(property.description || property.type === 'boolean' || property.properties, `${tool.name}.${name} is described`);
      }
      for (const required of tool.inputSchema.required ?? []) {
        assert.ok(required in tool.inputSchema.properties, `${tool.name} requires a declared property`);
      }
    }

    if (era === 'modern') {
      assert.equal(result.resultType, 'complete');
      assert.equal(typeof result.ttlMs, 'number');
      assert.equal(result.cacheScope, 'public');
    } else {
      assert.deepEqual(Object.keys(result), ['tools']);
    }
  });

  test(`a tool call round-trips (${era})`, async (t) => {
    const { client, fake } = await startServer(t, { era });
    fake.onChat(() => ({ content: 'こんにちは' }));
    const { text, isError, result } = await client.callTool('chat', { prompt: 'hello' });

    assert.equal(isError, false);
    assert.match(text, /^こんにちは\n\[PLaMo\] model: plamo-3\.1-prime/);
    assert.equal(result.resultType, era === 'modern' ? 'complete' : undefined);
  });
}

test('an unsupported modern protocol version lists the supported ones', async (t) => {
  const { client } = await startServer(t, { connect: false });
  const response = await client.request('tools/list', {}, { meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } });

  assert.equal(response.error.code, -32022);
  assert.deepEqual(response.error.data, { supported: [MODERN_VERSION], requested: '2099-01-01' });
});

test('protocol errors use the standard JSON-RPC codes', async (t) => {
  const { client } = await startServer(t, { era: 'legacy' });

  assert.equal((await client.request('resources/list')).error.code, -32601, 'unknown method');
  assert.equal((await client.request('server/discover')).error.code, -32602, 'discover without protocol metadata');
  assert.equal((await client.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602, 'unknown tool');
  assert.deepEqual((await client.request('ping')).result, {}, 'ping is answered in the legacy era');
});

test('ping and initialize are not part of the modern protocol', async (t) => {
  const { client } = await startServer(t);
  assert.equal((await client.request('ping')).error.code, -32601);
  const initialize = await client.request('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(initialize.error.code, -32601);
  assert.match(initialize.error.message, /omit the protocol version/);
});

test('malformed input is reported and does not stop the server', async (t) => {
  const { client } = await startServer(t);

  client.sendRaw('this is not json');
  client.sendRaw('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
  client.sendRaw('');
  client.sendRaw('{"jsonrpc":"2.0","result":{},"id":99}'); // a response: ignored
  client.notify('notifications/initialized');
  client.notify('notifications/something/unknown', { x: 1 });
  const { result } = await client.request('tools/list');

  assert.equal(result.tools.length, TOOL_NAMES.length);
  const errors = client.notifications.filter((message) => message.error);
  assert.deepEqual(errors.map((message) => message.error.code), [-32700, -32600]);
  assert.ok(errors.every((message) => !('id' in message)), 'no id is invented for an unreadable request');
  assert.deepEqual(client.garbage, [], 'stdout carries nothing but protocol messages');
});

test('invalid tool arguments come back as a tool error the model can read', async (t) => {
  const { client, fake } = await startServer(t);

  const missing = await client.callTool('chat', {});
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Invalid arguments for chat: missing required parameter "prompt"/);

  const unknown = await client.callTool('chat', { prompt: 'x', file: 'a.txt' });
  assert.match(unknown.text, /unknown parameter "file" \(allowed: prompt, system, files,/);

  const range = await client.callTool('chat', { prompt: 'x', max_tokens: 999999 });
  assert.match(range.text, /"max_tokens" must be <= 20480/);

  assert.equal(fake.chatRequests().length, 0, 'nothing was sent to the API');
});

test('loosely typed arguments are coerced instead of rejected', async (t) => {
  const { client, fake, write } = await startServer(t);
  await write('note.txt', 'memo');

  const { isError } = await client.callTool('chat', { prompt: 'x', max_tokens: '100', reasoning: 'true', files: 'note.txt', system: null });
  assert.equal(isError, false);
  const [{ body }] = fake.chatRequests();
  assert.equal(body.max_tokens, 100);
  assert.equal(body.reasoning_effort, 'medium');
  assert.match(body.messages[0].content, /File: note\.txt/);
  assert.equal(body.messages.length, 1, 'a null system prompt counts as absent');
});

test('progress notifications carry the token of the call and increase', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: 'あ'.repeat(30) }));
  await client.callTool('chat', { prompt: 'x' }, { progressToken: 'tok-1' });

  const progress = client.notifications.filter((message) => message.method === 'notifications/progress');
  assert.ok(progress.length >= 1);
  assert.ok(progress.every((message) => message.params.progressToken === 'tok-1'));
  const steps = progress.map((message) => message.params.progress);
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'progress never goes backwards');
  assert.match(progress[0].params.message, /Waiting for PLaMo/);
});

test('no progress is sent when the client did not ask for it', async (t) => {
  const { client } = await startServer(t);
  await client.callTool('chat', { prompt: 'x' });
  assert.deepEqual(client.notifications, []);
});

test('a cancelled call sends no response and the server keeps working', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat((body) => (body.messages[0].content === 'slow' ? { content: 'late', delayMs: 2000 } : { content: 'fast' }));

  let answered = false;
  client.request('tools/call', { name: 'chat', arguments: { prompt: 'slow' } }, { id: 'slow-call' }).then(() => {
    answered = true;
  }, () => {});
  // Wait until the request has reached the API, then cancel it.
  while (fake.chatRequests().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  client.notify('notifications/cancelled', { requestId: 'slow-call', reason: 'user pressed escape' });

  const { text } = await client.callTool('chat', { prompt: 'quick' });
  assert.match(text, /^fast/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(answered, false, 'the cancelled request is never answered');
});

test('calls run concurrently', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat((body) => (body.messages[0].content === 'slow' ? { content: 'slow done', delayMs: 300 } : { content: 'fast done' }));

  const order = [];
  const slow = client.callTool('chat', { prompt: 'slow' }).then(() => order.push('slow'));
  const fast = client.callTool('chat', { prompt: 'fast' }).then(() => order.push('fast'));
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['fast', 'slow']);
});

test('the server exits when stdin closes', async (t) => {
  const { client } = await startServer(t);
  const exit = await client.close();
  assert.equal(exit.code, 0);
  assert.equal(client.stderr, '');
});

test('the server exits on SIGINT, the signal Claude Code sends first', async (t) => {
  const { client } = await startServer(t);
  client.kill('SIGINT');
  const exit = await client.exited;
  assert.equal(exit.code, 0);
});

test('an invalid base URL is reported on stderr at startup', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_BASE_URL: 'not a url' }, connect: false });
  const exit = await client.exited;
  assert.equal(exit.code, 1);
  assert.match(client.stderr, /PLAMO_BASE_URL is not a valid URL/);
});

test('a base URL with credentials is refused at startup, without echoing them', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_BASE_URL: 'https://user:hunter2@proxy.example/v1' }, connect: false });
  const exit = await client.exited;
  assert.equal(exit.code, 1);
  assert.match(client.stderr, /PLAMO_BASE_URL must not contain a user name or password/);
  assert.ok(!client.stderr.includes('hunter2'));
});

test('argument names that collide with built-in properties are rejected like any unknown parameter', async (t) => {
  const { client, fake, write, read } = await startServer(t);
  await write('keep.md', 'keep me');

  // Built from JSON so that "__proto__" is a real key of the arguments, as it would be on the wire.
  const hostile = JSON.parse('{"prompt":"hi","output_file":"keep.md","__proto__":{"overwrite":"yes","max_tokens":999999}}');
  const smuggled = await client.callTool('chat', hostile);
  assert.equal(smuggled.isError, true);
  assert.match(smuggled.text, /unknown parameter "__proto__"/);

  const typed = await client.callTool('translate', JSON.parse('{"__proto__":{"text":42}}'));
  assert.equal(typed.isError, true);
  assert.match(typed.text, /Invalid arguments for translate: unknown parameter "__proto__"/);

  for (const name of ['constructor', 'toString']) {
    const result = await client.callTool('chat', { prompt: 'hi', [name]: 'x' });
    assert.match(result.text, new RegExp(`unknown parameter "${name}"`));
  }
  assert.equal(fake.requests.length, 0);
  assert.equal(await read('keep.md'), 'keep me');
  assert.equal(client.stderr, '', 'no handler was reached, so nothing failed unexpectedly');
});

test('when a call has failed, what it left running stops: no more requests, no progress on an answered call', async (t) => {
  const { client, fake, write } = await startServer(t);
  const paragraph = `${'lorem ipsum dolor sit amet '.repeat(8).trim()}.`;
  await write('long.md', Array.from({ length: 60 }, (_, index) => `## Section ${index + 1}\n\n${paragraph}\n\n${paragraph}\n\n`).join(''));
  let calls = 0;
  fake.onChat(async (body) => {
    calls += 1;
    if (calls === 1) return { status: 400, errorBody: { detail: 'content rejected' } };
    return { content: body.messages[body.messages.length - 1].content, delayMs: 30 };
  });

  const { text, isError } = await client.callTool('translate', { input_file: 'long.md', target_language: 'ja', output_file: 'long.ja.md' }, { progressToken: 5 });
  assert.equal(isError, true);
  assert.match(text, /HTTP 400\): content rejected/);
  const requestsAtAnswer = fake.chatRequests().length;
  const notificationsAtAnswer = client.notifications.length;
  assert.ok(requestsAtAnswer <= 3, `only the parts already under way were sent, got ${requestsAtAnswer}`);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fake.chatRequests().length, requestsAtAnswer, 'no request is started after the call has failed');
  assert.equal(client.notifications.length, notificationsAtAnswer, 'and no progress is reported on it');
});
