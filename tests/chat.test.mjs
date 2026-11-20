// The chat tool: request building, conversations, files, output and failure handling.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

import { CONTEXT_LENGTH } from './helpers/fake-plamo.mjs';
import { lastUserMessage, startServer } from './helpers/harness.mjs';

test('sends a streamed completion request and returns the answer with usage', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: '夏目漱石です。', usage: { prompt_tokens: 29, completion_tokens: 5, total_tokens: 34 } }));

  const { text, isError } = await client.callTool('chat', { prompt: '「吾輩は猫である」の作者は？' });

  assert.equal(isError, false);
  assert.match(text, /^夏目漱石です。\n\[PLaMo\] model: plamo-3\.1-prime \| tokens: 29 in \/ 5 out \| conversation_id: c_[0-9a-f]{8}$/);
  const [request] = fake.chatRequests();
  assert.deepEqual(request.body, {
    model: 'plamo-3.1-prime',
    messages: [{ role: 'user', content: '「吾輩は猫である」の作者は？' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.match(request.headers['user-agent'], /^plamo-plugin-cc\/\d+\.\d+\.\d+/);
});

test('passes the optional parameters through', async (t) => {
  const { client, fake } = await startServer(t);
  await client.callTool('chat', { prompt: 'q', system: 'あなたは編集者です。', reasoning: true, max_tokens: 4000, temperature: 0.7 });

  const [{ body }] = fake.chatRequests();
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'あなたは編集者です。' },
    { role: 'user', content: 'q' },
  ]);
  assert.equal(body.reasoning_effort, 'medium');
  assert.equal(body.max_tokens, 4000);
  assert.equal(body.temperature, 0.7);
});

test('reasoning is off unless requested', async (t) => {
  const { client, fake } = await startServer(t);
  await client.callTool('chat', { prompt: 'q', reasoning: false });
  assert.equal('reasoning_effort' in fake.chatRequests()[0].body, false);
});

test('reports reasoning tokens', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: 'はい。', usage: { prompt_tokens: 50, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 106 } } }));
  const { text } = await client.callTool('chat', { prompt: 'q', reasoning: true });
  assert.match(text, /tokens: 50 in \/ 120 out, 106 of them reasoning/);
});

test('uses the model from the plugin option, then PLAMO_MODEL', async (t) => {
  const option = await startServer(t, { env: { PLAMO_PLUGIN_OPTION_MODEL: 'plamo-3.0-prime', PLAMO_MODEL: 'plamo-3.0-fin-beta' } });
  await option.client.callTool('chat', { prompt: 'q' });
  assert.equal(option.fake.chatRequests()[0].body.model, 'plamo-3.0-prime');

  // An option the user left empty arrives as an empty string.
  const environment = await startServer(t, { env: { PLAMO_PLUGIN_OPTION_MODEL: '', PLAMO_MODEL: 'plamo-3.0-fin-beta' } });
  await environment.client.callTool('chat', { prompt: 'q' });
  assert.equal(environment.fake.chatRequests()[0].body.model, 'plamo-3.0-fin-beta');
});

test('the API key from the plugin option takes precedence over PLAMO_API_KEY', async (t) => {
  const { client, fake } = await startServer(t, { env: { PLAMO_PLUGIN_OPTION_API_KEY: 'test-key', PLAMO_API_KEY: 'another-key' } });
  const { isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, false);
  assert.equal(fake.chatRequests()[0].headers.authorization, 'Bearer test-key');
});

test('attaches files from the project as fenced blocks', async (t) => {
  const { client, fake, write } = await startServer(t);
  await write('src/app.py', 'print("hi")\n');
  const absolute = await write('notes.md', 'A fence inside:\n```js\nlet x;\n```\n');

  const { text } = await client.callTool('chat', { prompt: 'このコードを説明して', files: ['src/app.py', absolute, 'src/app.py'] });

  const prompt = lastUserMessage(fake.chatRequests()[0]);
  assert.ok(prompt.startsWith('このコードを説明して\n\n--- Attached files (2) ---'), 'a repeated path is attached once');
  assert.ok(prompt.includes('File: src/app.py\n```py\nprint("hi")\n```'));
  assert.ok(prompt.includes('File: notes.md\n````md\nA fence inside:\n```js\nlet x;\n```\n````'), 'the fence is longer than any fence in the file');
  assert.match(text, /files: src\/app\.py, notes\.md/);
});

test('refuses files outside the project, credentials, binaries and missing files', async (t) => {
  const { client, fake, write, resolve } = await startServer(t);
  await write('.env', 'SECRET=1\n');
  await write('config/credentials.json', '{}');
  await write('image.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await fs.symlink('/etc/hosts', resolve('link-out'));

  const cases = [
    ['/etc/hosts', /outside the project directory/],
    ['../elsewhere.txt', /File not found|outside the project directory/],
    ['link-out', /outside the project directory/],
    ['.env', /looks like it contains credentials/],
    ['config/credentials.json', /looks like it contains credentials/],
    ['image.bin', /looks like a binary file/],
    ['missing.txt', /File not found: missing\.txt/],
    ['config', /is a directory/],
  ];
  for (const [file, expected] of cases) {
    const { text, isError } = await client.callTool('chat', { prompt: 'q', files: [file] });
    assert.equal(isError, true, file);
    assert.match(text, expected, file);
  }
  assert.equal(fake.requests.length, 0, 'nothing reached the API');
});

test('PLAMO_ALLOWED_DIRS opens additional directories', async (t) => {
  const other = await startServer(t);
  const outside = await other.write('shared.txt', 'shared notes');
  const { client, fake } = await startServer(t, { env: { PLAMO_ALLOWED_DIRS: other.projectDir } });

  const { isError } = await client.callTool('chat', { prompt: 'q', files: [outside] });
  assert.equal(isError, false);
  assert.ok(lastUserMessage(fake.chatRequests()[0]).includes('shared notes'));
});

test('continues a conversation by id', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat((body) => ({ content: `answer ${body.messages.filter((message) => message.role === 'user').length}` }));

  const first = await client.callTool('chat', { prompt: '最初の質問', system: 'S' });
  const id = /conversation_id: (c_[0-9a-f]+)/.exec(first.text)[1];
  const second = await client.callTool('chat', { prompt: '続きの質問', conversation_id: id });

  assert.match(second.text, new RegExp(`conversation_id: ${id}`), 'the id stays the same');
  assert.deepEqual(fake.chatRequests()[1].body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: '最初の質問' },
    { role: 'assistant', content: 'answer 1' },
    { role: 'user', content: '続きの質問' },
  ]);

  await client.callTool('chat', { prompt: '三つ目', conversation_id: id, system: 'S2' });
  assert.equal(fake.chatRequests()[2].body.messages[0].content, 'S2', 'a new system prompt replaces the old one');
  assert.equal(fake.chatRequests()[2].body.messages.length, 6);
});

test('an unknown conversation id is an error, not a silent new conversation', async (t) => {
  const { client, fake } = await startServer(t);
  const { text, isError } = await client.callTool('chat', { prompt: 'q', conversation_id: 'c_deadbeef' });
  assert.equal(isError, true);
  assert.match(text, /Unknown conversation_id "c_deadbeef"/);
  assert.equal(fake.requests.length, 0);
});

test('wraps a bare JSON Schema and passes a complete one through', async (t) => {
  const { client, fake } = await startServer(t);
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
  fake.onChat(() => ({ content: '{"city":"静岡市"}' }));

  const bare = await client.callTool('chat', { prompt: 'q', json_schema: schema });
  assert.deepEqual(fake.chatRequests()[0].body.response_format, { type: 'json_schema', json_schema: { name: 'response', schema, strict: true } });
  assert.doesNotMatch(bare.text, /warning/);

  const complete = { name: 'answer', schema, strict: false };
  await client.callTool('chat', { prompt: 'q', json_schema: complete });
  assert.deepEqual(fake.chatRequests()[1].body.response_format, { type: 'json_schema', json_schema: complete });
});

test('warns when structured output is not valid JSON', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: 'すみません、JSON にできません。' }));
  const { text } = await client.callTool('chat', { prompt: 'q', json_schema: { type: 'object' } });
  assert.match(text, /warning: the answer is not valid JSON/);
});

test('saves the answer to output_file and returns a preview', async (t) => {
  const { client, fake, read } = await startServer(t);
  fake.onChat(() => ({ content: '# 下書き\n\n本文です。' }));

  const { text, isError } = await client.callTool('chat', { prompt: '下書きを書いて', output_file: 'docs/draft.md' });

  assert.equal(isError, false);
  assert.equal(await read('docs/draft.md'), '# 下書き\n\n本文です。\n', 'parent directories are created and the file ends with a newline');
  assert.match(text, /^Saved PLaMo's answer to docs\/draft\.md \(12 characters\)\. Preview:\n\n# 下書き/);
});

test('never replaces a file unless overwrite is set', async (t) => {
  const { client, fake, write, read } = await startServer(t);
  await write('draft.md', 'original');
  fake.onChat(() => ({ content: 'new text' }));

  const refused = await client.callTool('chat', { prompt: 'q', output_file: 'draft.md' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /draft\.md already exists/);
  assert.equal(fake.requests.length, 0, 'the destination is checked before anything is spent');
  assert.equal(await read('draft.md'), 'original');

  const replaced = await client.callTool('chat', { prompt: 'q', output_file: 'draft.md', overwrite: true });
  assert.equal(replaced.isError, false);
  assert.equal(await read('draft.md'), 'new text\n');
});

test('refuses to write outside the project or into hidden directories', async (t) => {
  const { client, fake, exists } = await startServer(t);
  for (const [target, expected] of [
    ['/tmp/plamo-should-not-exist.md', /outside the project directory/],
    ['../escape.md', /outside the project directory/],
    ['.git/hooks/pre-commit', /cannot be hidden files or live in hidden directories \(found "\.git"\)/],
    ['.claude/settings.json', /found "\.claude"/],
    ['docs/.hidden.md', /found "\.hidden\.md"/],
  ]) {
    const { text, isError } = await client.callTool('chat', { prompt: 'q', output_file: target });
    assert.equal(isError, true, target);
    assert.match(text, expected, target);
  }
  assert.equal(fake.requests.length, 0);
  assert.equal(await exists('.git'), false);
});

test('flags an answer that was cut off', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: '途中まで', finishReason: 'length' }));
  const { text, isError } = await client.callTool('chat', { prompt: 'q', max_tokens: 10 });
  assert.equal(isError, false);
  assert.match(text, /warning: the answer was cut off at max_tokens/);
});

test('explains an empty answer caused by reasoning using up max_tokens', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: '', finishReason: 'length' }));
  const { text, isError } = await client.callTool('chat', { prompt: 'q', reasoning: true, max_tokens: 100 });
  assert.equal(isError, true);
  assert.match(text, /reached max_tokens \(100\) while it was still reasoning\. Retry with a larger max_tokens, or with reasoning turned off/);
});

test('handles a plain JSON response when the endpoint does not stream', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: 'plain', json: true, usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  const { text } = await client.callTool('chat', { prompt: 'q' });
  assert.match(text, /^plain\n\[PLaMo\] model: plamo-3\.1-prime \| tokens: 3 in \/ 1 out/);
});

test('fits max_tokens to the room left when the input is very long', async (t) => {
  const { client, fake, write } = await startServer(t);
  await write('big.txt', 'あ'.repeat(130_000));
  fake.onTokenize(() => CONTEXT_LENGTH - 5000);

  await client.callTool('chat', { prompt: '要約して', files: ['big.txt'] });

  const tokenize = fake.requests.find((request) => request.path === '/v1/tokenize');
  assert.equal(tokenize.body.model, 'plamo-3.1-prime');
  assert.equal(tokenize.body.messages.length, 1);
  assert.equal(fake.chatRequests()[0].body.max_tokens, 5000 - 64);
});

test('short inputs are not tokenized first', async (t) => {
  const { client, fake } = await startServer(t);
  await client.callTool('chat', { prompt: 'short' });
  assert.deepEqual(fake.requests.map((request) => request.path), ['/v1/chat/completions']);
});

test('rejects an input that cannot fit in the context window', async (t) => {
  const { client, fake, write } = await startServer(t);
  await write('big.txt', 'あ'.repeat(130_000));
  fake.onTokenize(() => CONTEXT_LENGTH - 10);

  const { text, isError } = await client.callTool('chat', { prompt: '要約して', files: ['big.txt'] });
  assert.equal(isError, true);
  assert.match(text, /The input is too long for plamo-3\.1-prime: about 262134 tokens, and the context window is 262144/);
  assert.equal(fake.chatRequests().length, 0);
});

test('without an API key it explains how to set one, without calling the API', async (t) => {
  const { client, fake } = await startServer(t, { env: { PLAMO_API_KEY: undefined } });
  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, true);
  assert.match(text, /The PLaMo API key is not configured\.\nRun \/plamo:setup/);
  assert.equal(fake.requests.length, 0);
});

test('an unsubstituted placeholder counts as no API key', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_API_KEY: undefined, PLAMO_PLUGIN_OPTION_API_KEY: '${user_config.api_key}' } });
  const { text } = await client.callTool('chat', { prompt: 'q' });
  assert.match(text, /API key is not configured/);
});

test('a rejected key points to /plamo:setup and is not retried', async (t) => {
  const { client, fake } = await startServer(t, { env: { PLAMO_API_KEY: 'wrong-key' } });
  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, true);
  assert.match(text, /PLaMo API error \(HTTP 401\): Unauthorized\nThe API key was rejected\. Run \/plamo:setup/);
  assert.equal(fake.requests.length, 1);
  assert.doesNotMatch(text, /wrong-key/, 'the key is never echoed');
});

test('an unknown model explains how to fix the configuration', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_MODEL: 'plamo-9.9-prime' } });
  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, true);
  assert.match(text, /HTTP 404\): model not found\nCheck the model name/);
});

test('retries rate limits and server errors, then succeeds', async (t) => {
  const { client, fake } = await startServer(t);
  fake.failNext(1, 429, { detail: 'rate limit exceeded' });
  fake.failNext(1, 503, { detail: 'overloaded' });
  fake.onChat(() => ({ content: 'ok' }));

  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, false);
  assert.match(text, /^ok/);
  assert.equal(fake.chatRequests().length, 3);
});

test('gives up after the retry budget and reports the last error', async (t) => {
  const { client, fake } = await startServer(t);
  fake.failNext(10, 429, { detail: 'rate limit exceeded' });

  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, true);
  assert.match(text, /HTTP 429\): rate limit exceeded\nRate limit or usage quota reached/);
  assert.equal(fake.chatRequests().length, 3, 'one attempt plus two retries');
});

test('does not retry a bad request', async (t) => {
  const { client, fake } = await startServer(t);
  fake.failNext(5, 400, { detail: 'messages: field required' });
  const { text } = await client.callTool('chat', { prompt: 'q' });
  assert.match(text, /HTTP 400\): messages: field required/);
  assert.equal(fake.chatRequests().length, 1);
});

test('reads validation errors given as a list', async (t) => {
  const { client, fake } = await startServer(t);
  fake.failNext(1, 422, { detail: [{ loc: ['body', 'messages', 0, 'content'], msg: 'Input should be a valid string', type: 'string_type' }] });
  const { text } = await client.callTool('chat', { prompt: 'q' });
  assert.match(text, /HTTP 422\): messages\.0\.content: Input should be a valid string/);
});

test('retries a stream that breaks off before the answer is complete', async (t) => {
  const { client, fake } = await startServer(t);
  let calls = 0;
  fake.onChat(() => {
    calls += 1;
    return calls === 1 ? { content: 'abcdefghi', dropAfterChunks: 1 } : { content: 'abcdefghi' };
  });

  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, false);
  assert.match(text, /^abcdefghi\n/);
  assert.equal(calls, 2);
});

test('reports an unreachable API clearly', async (t) => {
  const { client } = await startServer(t, { env: { PLAMO_BASE_URL: 'http://127.0.0.1:9/v1', PLAMO_MAX_RETRIES: '1' } });
  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, true);
  assert.match(text, /Could not reach the PLaMo API at http:\/\/127\.0\.0\.1:9 \(.+\)\.\nCheck the network connection/);
});

test('reports an error that arrives in the middle of a stream', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: 'abcdefghi', streamError: { code: 'internal', message: 'the model server went away', details: [] } }));
  const { text, isError } = await client.callTool('chat', { prompt: 'q' });
  assert.equal(isError, true);
  assert.match(text, /^PLaMo error: the model server went away$/);
  assert.equal(fake.chatRequests().length, 1, 'the reason is reported, not retried away');
});

test('a malformed API key is refused before it is sent, and is never echoed', async (t) => {
  const secret = 'plamo-SECRET-abc123';
  for (const key of [`${secret}\n# my work key`, `${secret} and more`, `“${secret}”`]) {
    const { client, fake } = await startServer(t, { env: { PLAMO_API_KEY: key } });
    const chat = await client.callTool('chat', { prompt: 'q' });
    const status = await client.callTool('status');
    assert.equal(chat.isError, true);
    assert.match(chat.text, /The PLaMo API key is set but malformed: it contains whitespace, a line break, or characters outside ASCII/);
    assert.equal(status.isError, true);
    assert.match(status.text, /- API key: MALFORMED \(PLAMO_API_KEY environment variable\)/);
    assert.match(status.text, /The PLaMo API key is set but malformed/);
    assert.equal(fake.requests.length, 0, 'nothing is sent with such a key');
    for (const output of [chat.text, status.text, client.stderr]) assert.ok(!output.includes(secret), 'the key appears nowhere');
  }
});

test('empty optional text arguments count as left out', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: 'ok' }));

  const first = await client.callTool('chat', { prompt: 'one', system: 'Be brief.', conversation_id: '', output_file: '' });
  assert.equal(first.isError, false);
  const id = /conversation_id: (c_[0-9a-f]+)/.exec(first.text)[1];

  await client.callTool('chat', { prompt: 'two', system: '', conversation_id: id });
  assert.deepEqual(
    fake.chatRequests()[1].body.messages.map((message) => `${message.role}: ${message.content}`),
    ['system: Be brief.', 'user: one', 'assistant: ok', 'user: two'],
    'an empty system prompt does not erase the one the conversation has',
  );
});

test('an answer that cannot be saved is returned instead of lost', async (t) => {
  const { client, fake, write, read } = await startServer(t);
  // The file appears while PLaMo is answering.
  fake.onChat(async () => {
    await write('answer.md', 'written by someone else');
    return { content: 'the answer' };
  });

  const { text, isError } = await client.callTool('chat', { prompt: 'q', output_file: 'answer.md' });
  assert.equal(isError, true);
  assert.match(text, /^answer\.md already exists\. Choose another path, or pass overwrite: true to replace it\.\nThe answer could not be saved, so it is returned here instead:\n\nthe answer\n\[PLaMo\]/);
  assert.equal(await read('answer.md'), 'written by someone else');
});

test('an output path that cannot be written is refused before anything is spent', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const { client, fake, resolve } = await startServer(t);
  await fs.mkdir(resolve('published'));
  await fs.chmod(resolve('published'), 0o555);

  for (const [tool, args] of [
    ['chat', { prompt: 'q', output_file: 'published/a.md' }],
    ['translate', { text: 'hello', output_file: 'published/a.{lang}.md' }],
  ]) {
    const { text, isError } = await client.callTool(tool, args);
    assert.equal(isError, true);
    assert.match(text, /published\/a(\.ja)?\.md cannot be written: the directory is read-only\. Choose another path\./);
  }
  assert.equal(fake.requests.length, 0);
});

test('replacing a file keeps its permissions', { skip: process.platform === 'win32' }, async (t) => {
  const { client, fake, write, read, resolve } = await startServer(t);
  await write('private.md', 'old');
  await fs.chmod(resolve('private.md'), 0o600);
  fake.onChat(() => ({ content: 'new' }));

  const { isError } = await client.callTool('chat', { prompt: 'q', output_file: 'private.md', overwrite: true });
  assert.equal(isError, false);
  assert.equal(await read('private.md'), 'new\n');
  assert.equal((await fs.stat(resolve('private.md'))).mode & 0o777, 0o600, 'a private file stays private');
});
