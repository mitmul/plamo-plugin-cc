// The web_search tool: request options, citations and usage reporting.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startServer } from './helpers/harness.mjs';

const citation = (url, title, start, end = start) => ({ type: 'url_citation', url_citation: { url, title, start_index: start, end_index: end } });

test('asks for a web search and marks the cited sources', async (t) => {
  const { client, fake } = await startServer(t);
  const answer = 'Node.js の Active LTS は 26.x です。 Maintenance LTS は 24.x です。';
  const firstSentenceEnd = answer.indexOf('。');
  const secondSentenceEnd = answer.lastIndexOf('。');
  fake.onChat(() => ({
    content: answer,
    webSearches: 2,
    usage: { prompt_tokens: 12486, completion_tokens: 599 },
    annotations: [
      citation('https://example.com/a', 'Node.js のバージョン情報', firstSentenceEnd),
      citation('https://example.com/b', 'LTS サポート状況', secondSentenceEnd),
      citation('https://example.com/a', 'Node.js のバージョン情報', secondSentenceEnd),
    ],
  }));

  const { text, isError } = await client.callTool('web_search', { query: 'Node.js の Active LTS は？' });

  assert.equal(isError, false);
  assert.equal(
    text,
    [
      'Node.js の Active LTS は 26.x です[1]。 Maintenance LTS は 24.x です[1][2]。',
      '',
      'Sources:',
      '[1] Node.js のバージョン情報 - https://example.com/a',
      '[2] LTS サポート状況 - https://example.com/b',
      '[PLaMo] model: plamo-3.1-prime | tokens: 12486 in / 599 out | web searches: 2',
    ].join('\n'),
  );

  const [{ body }] = fake.chatRequests();
  assert.deepEqual(body.web_search_options, { search_context_size: 'medium' });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Node.js の Active LTS は？' }]);
  for (const forbidden of ['temperature', 'top_p', 'tools', 'tool_choice', 'n', 'seed', 'stop']) {
    assert.equal(forbidden in body, false, `${forbidden} must not be sent with web_search_options`);
  }
});

test('maps context size, domains and location onto web_search_options', async (t) => {
  const { client, fake } = await startServer(t);
  await client.callTool('web_search', {
    query: 'q',
    context_size: 'high',
    allowed_domains: ['go.jp', 'preferred.jp'],
    location: { country: 'JP', city: 'Tokyo', timezone: 'Asia/Tokyo' },
    reasoning: true,
    max_tokens: 3000,
  });

  const [{ body }] = fake.chatRequests();
  assert.deepEqual(body.web_search_options, {
    search_context_size: 'high',
    user_location: { type: 'approximate', approximate: { country: 'JP', city: 'Tokyo', timezone: 'Asia/Tokyo' } },
    filters: { allowed_domains: ['go.jp', 'preferred.jp'] },
  });
  assert.equal(body.reasoning_effort, 'medium');
  assert.equal(body.max_tokens, 3000);
});

test('keeps inline links for citations that cover a span of text', async (t) => {
  const { client, fake } = await startServer(t);
  const answer = '本社は東京都千代田区です。 ([doda.jp](https://doda.jp/x))';
  fake.onChat(() => ({ content: answer, webSearches: 1, annotations: [citation('https://doda.jp/x', 'doda', 14, answer.length)] }));

  const { text } = await client.callTool('web_search', { query: 'q' });
  assert.ok(text.startsWith(`${answer}\n\nSources:\n[1] doda - https://doda.jp/x`), 'the text is unchanged and the source is still listed');
});

test('counts citation positions in code points', async (t) => {
  const { client, fake } = await startServer(t);
  const answer = '𠮷野家は牛丼店です。';
  fake.onChat(() => ({ content: answer, webSearches: 1, annotations: [citation('https://example.com', '', Array.from(answer).length - 1)] }));

  const { text } = await client.callTool('web_search', { query: 'q' });
  assert.ok(text.startsWith('𠮷野家は牛丼店です[1]。\n\nSources:\n[1] https://example.com'));
});

test('ignores citation positions that do not fit the text', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: '短い答え。', webSearches: 1, annotations: [citation('https://example.com', 'T', 999)] }));
  const { text } = await client.callTool('web_search', { query: 'q' });
  assert.ok(text.startsWith('短い答え。\n\nSources:\n[1] T - https://example.com'));
});

test('warns when the answer cites nothing', async (t) => {
  const { client, fake } = await startServer(t);
  fake.onChat(() => ({ content: 'わかりませんでした。' }));
  const { text } = await client.callTool('web_search', { query: 'q' });
  assert.equal(text, 'わかりませんでした。\n[PLaMo] model: plamo-3.1-prime | tokens: 12 in / 7 out | web searches: 0 | warning: the answer cites no sources');
});

test('validates its arguments', async (t) => {
  const { client, fake } = await startServer(t);
  const cases = [
    [{}, /missing required parameter "query"/],
    [{ query: '' }, /"query" must not be empty/],
    [{ query: 'q', context_size: 'huge' }, /"context_size" must be one of: "low", "medium", "high"/],
    [{ query: 'q', allowed_domains: [] }, /"allowed_domains" must have at least 1 item/],
    [{ query: 'q', location: { planet: 'Earth' } }, /unknown parameter "location\.planet"/],
  ];
  for (const [args, expected] of cases) {
    const { text, isError } = await client.callTool('web_search', args);
    assert.equal(isError, true);
    assert.match(text, expected);
  }
  assert.equal(fake.requests.length, 0);
});

test('a search that fails after it was sent is not repeated, because searches are billed', async (t) => {
  const { client, fake } = await startServer(t);

  // The answer breaks off: the searches behind it have been made.
  fake.onChat(() => ({ content: 'abcdefghi', dropAfterChunks: 1 }));
  const broken = await client.callTool('web_search', { query: 'q' });
  assert.equal(broken.isError, true);
  assert.match(
    broken.text,
    /^PLaMo error: The connection to the PLaMo API broke off before the answer was complete \(.+\)\.\nCheck the network connection and any proxy settings\. The search was not repeated automatically, because searches that were already made are billed\./,
  );
  assert.equal(fake.chatRequests().length, 1);

  // A gateway error: nobody can tell whether the request got through.
  fake.failNext(1, 502, { detail: 'bad gateway' });
  const gateway = await client.callTool('web_search', { query: 'q' });
  assert.equal(gateway.isError, true);
  assert.match(gateway.text, /HTTP 502\): bad gateway\nThe PLaMo API is temporarily unavailable\. Try again later\. The search was not repeated automatically/);
  assert.equal(fake.chatRequests().length, 2);

  // A rate limit means the request was turned away, so sending it again cannot bill anything twice.
  fake.failNext(1, 429, { detail: 'rate limit exceeded' });
  fake.onChat(() => ({ content: 'answer', webSearches: 1 }));
  const limited = await client.callTool('web_search', { query: 'q' });
  assert.equal(limited.isError, false);
  assert.match(limited.text, /^answer/);
  assert.equal(fake.chatRequests().length, 4);
});

test('is not announced as read-only or repeatable, since every call is billed', async (t) => {
  const { client } = await startServer(t);
  const { result } = await client.request('tools/list');
  const annotations = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.annotations]));
  assert.deepEqual(
    { readOnly: annotations.web_search.readOnlyHint, idempotent: annotations.web_search.idempotentHint },
    { readOnly: false, idempotent: false },
    'Claude Code may repeat a call to a read-only or idempotent tool on its own',
  );
  assert.equal(annotations.deep_research_start.idempotentHint, false);
  assert.equal(annotations.deep_research_start.readOnlyHint, false);
  // Tools that can replace a file with overwrite say that they may be destructive.
  for (const name of ['chat', 'translate', 'deep_research_get']) assert.equal(annotations[name].destructiveHint, true, name);
  for (const name of ['status', 'count_tokens']) assert.equal(annotations[name].readOnlyHint, true, name);
});

test('surfaces the API error for an incompatible request', async (t) => {
  const { client, fake } = await startServer(t);
  fake.failNext(1, 400, { detail: 'Model incompatible request argument supplied: web_search_options' });
  const { text, isError } = await client.callTool('web_search', { query: 'q' });
  assert.equal(isError, true);
  assert.match(text, /HTTP 400\): Model incompatible request argument supplied: web_search_options/);
});
