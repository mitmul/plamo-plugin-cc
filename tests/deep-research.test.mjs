// The deep_research_* tools: job lifecycle, progress, report rendering.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { startServer } from './helpers/harness.mjs';

const REPORT = [
  '# 調査レポート',
  '',
  '日本ではAI事業者ガイドラインが整備されました。[1] 法制化の議論も進んでいます。[2]',
  '',
  'Sources:',
  '[1] AI 政策の概要 - https://example.go.jp/ai',
  '[2] ニュース - https://example.com/news',
].join('\n');

async function startJob(client, args = { topic: '日本の生成AI規制の動向' }) {
  const { text, isError } = await client.callTool('deep_research_start', args);
  assert.equal(isError, false, text);
  return /Deep Research job started: (resp_[0-9a-f]+)/.exec(text)[1];
}

test('starts a background job and remembers it', async (t) => {
  const { client, fake, dataDir, projectDir } = await startServer(t);

  const { text } = await client.callTool('deep_research_start', {
    topic: '日本の生成AI規制の動向',
    allowed_domains: ['go.jp'],
    blocked_domains: ['example.org'],
    max_tool_calls: 20,
  });

  const [{ body }] = fake.requests.filter((request) => request.path === '/v1/responses');
  assert.deepEqual(body, {
    model: 'plamo-3.1-prime-deep-research',
    input: '日本の生成AI規制の動向',
    background: true,
    store: true,
    tools: [{ type: 'web_search', filters: { allowed_domains: ['go.jp'], blocked_domains: ['example.org'] } }],
    max_tool_calls: 20,
  });
  const id = /job started: (resp_\w+) \(status: queued\)/.exec(text)[1];
  assert.match(text, new RegExp(`Next: call deep_research_get with id "${id}" and wait: true`));

  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'research-jobs.json'), 'utf8'));
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].id, id);
  assert.equal(saved.jobs[0].topic, '日本の生成AI規制の動向');
  assert.equal(saved.jobs[0].projectDir, projectDir);
});

test('sends no tools or limits unless asked', async (t) => {
  const { client, fake } = await startServer(t);
  await startJob(client);
  const [{ body }] = fake.requests.filter((request) => request.path === '/v1/responses');
  assert.deepEqual(Object.keys(body).sort(), ['background', 'input', 'model', 'store']);
});

test('reports a running job without waiting', async (t) => {
  const { client, fake } = await startServer(t);
  fake.scriptJob({ pollsUntilDone: 5 });
  const id = await startJob(client);

  const { text, isError } = await client.callTool('deep_research_get', { id });
  assert.equal(isError, false);
  assert.match(text, new RegExp(`^Deep Research job ${id} is still in_progress \\(started \\d+s ago\\)\\. A job can take up to about 25 minutes\\.`));
  assert.match(text, /\[PLaMo\] id: resp_\w+ \| status: in_progress \| model: plamo-3\.1-prime-deep-research$/);
});

test('waits for the job, reports progress from the event stream and renders the report', async (t) => {
  const { client, fake } = await startServer(t);
  // Polling alone would never see the job finish: only the event stream completes it.
  fake.scriptJob({ pollsUntilDone: 1_000_000 });
  const id = await startJob(client);

  const { text, isError, progress } = await client.callTool('deep_research_get', { id, wait: true }, { progressToken: 'dr' });

  assert.equal(isError, false);
  assert.equal(text, `${REPORT}\n[PLaMo] id: ${id} | status: completed | model: plamo-3.1-prime-deep-research | web searches: 4 | tokens: 24282 in / 3892 out`);
  assert.match(progress[0], /^Deep Research \(\d+s\): Queued…$/);
  assert.equal(fake.job(id).streamRequests, 1);
});

test('returns a finished job at once, without opening the event stream', async (t) => {
  const { client, fake } = await startServer(t);
  const id = await startJob(client);

  const { text } = await client.callTool('deep_research_get', { id, wait: true });
  assert.ok(text.startsWith(REPORT));
  assert.equal(fake.job(id).streamRequests, undefined);
});

test('describes searches, page reads and writing as progress', async () => {
  const { describeResearchEvent } = await import('../plugins/plamo/server/lib/tools/deep-research.mjs');
  const added = (item) => ({ type: 'response.output_item.added', item });

  assert.equal(describeResearchEvent({ type: 'response.queued' }), 'Queued…');
  assert.equal(describeResearchEvent({ type: 'response.in_progress' }), 'Research started…');
  assert.equal(describeResearchEvent(added({ type: 'web_search_call', action: { type: 'search', query: '生成AI 規制' } })), 'Searching: 生成AI 規制');
  assert.equal(describeResearchEvent(added({ type: 'web_search_call', action: { type: 'search', queries: ['a', 'b'] } })), 'Searching: a, b');
  assert.equal(describeResearchEvent(added({ type: 'web_search_call', action: { type: 'open_page', url: 'https://x', title: 'T' } })), 'Reading: T');
  assert.equal(describeResearchEvent(added({ type: 'web_search_call', action: { type: 'open_page', url: 'https://x' } })), 'Reading: https://x');
  assert.equal(describeResearchEvent(added({ type: 'web_search_call', action: { type: 'find', url: 'https://x', pattern: 'p' } })), 'Looking through: https://x');
  assert.equal(describeResearchEvent(added({ type: 'message' })), 'Writing the report…');
  assert.equal(describeResearchEvent(added({ type: 'reasoning' })), null);
  assert.equal(describeResearchEvent({ type: 'response.output_text.delta', delta: 'x' }), null);
});

test('falls back to polling when the event stream is unavailable', async (t) => {
  const { client, fake } = await startServer(t);
  fake.scriptJob({ streamUnavailable: true, pollsUntilDone: 3 });
  const id = await startJob(client);

  const { text, progress } = await client.callTool('deep_research_get', { id, wait: true }, { progressToken: 'dr' });

  assert.ok(text.startsWith(REPORT));
  assert.ok(progress.some((message) => /^Deep Research \(\d+s\): in_progress$/.test(message)));
  const polls = fake.requests.filter((request) => request.method === 'GET' && request.path === `/v1/responses/${id}` && !request.query.stream);
  assert.ok(polls.length >= 4, 'the job was polled until it finished');
});

test('resumes the event stream after it breaks off', async (t) => {
  const { client, fake } = await startServer(t);
  fake.scriptJob({ streamEndsEarly: true, pollsUntilDone: 100 });
  const id = await startJob(client);

  const { text } = await client.callTool('deep_research_get', { id, wait: true });

  assert.ok(text.startsWith(REPORT));
  const streams = fake.requests.filter((request) => request.query.stream === 'true');
  assert.equal(streams.length, 2);
  assert.equal(streams[0].query.starting_after, undefined);
  assert.equal(streams[1].query.starting_after, '6', 'the second stream starts after the last event that was received');
});

test('stops waiting after the waiting budget and says the job is still running', async (t) => {
  const { client, fake } = await startServer(t, { env: { PLAMO_RESEARCH_WAIT_MS: '80' } });
  fake.scriptJob({ streamUnavailable: true, pollsUntilDone: 1_000_000 });
  const id = await startJob(client);

  const { text, isError } = await client.callTool('deep_research_get', { id, wait: true });
  assert.equal(isError, false);
  assert.match(text, /is still in_progress/);
});

test('saves the report to output_file', async (t) => {
  const { client, read } = await startServer(t);
  const id = await startJob(client);

  const { text } = await client.callTool('deep_research_get', { id, wait: true, output_file: 'reports/ai-regulation.md' });

  assert.equal(await read('reports/ai-regulation.md'), `${REPORT}\n`);
  assert.match(text, new RegExp(`^Saved the Deep Research report to reports/ai-regulation\\.md \\(${REPORT.length} characters, 2 sources\\)\\. Preview:\\n\\n# 調査レポート`));

  // Fetching again is free and idempotent, but an existing file is not replaced silently.
  const again = await client.callTool('deep_research_get', { id, output_file: 'reports/ai-regulation.md' });
  assert.equal(again.isError, true);
  assert.match(again.text, /already exists/);
});

test('joins several message items and numbers their sources once', async (t) => {
  const { client, fake } = await startServer(t);
  const part = (text, url) => ({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url, title: '', start_index: Array.from(text).length, end_index: Array.from(text).length }] }],
  });
  fake.scriptJob({ output: [part('第一章。', 'https://a.example'), { type: 'reasoning', summary: [] }, part('第二章。', 'https://b.example'), part('第三章。', 'https://a.example')] });
  const id = await startJob(client);

  const { text } = await client.callTool('deep_research_get', { id, wait: true });
  assert.ok(text.startsWith('第一章。[1]\n\n第二章。[2]\n\n第三章。[1]\n\nSources:\n[1] https://a.example\n[2] https://b.example\n[PLaMo]'), text);
});

test('explains incomplete, failed and cancelled jobs', async (t) => {
  const { client, fake } = await startServer(t);

  fake.scriptJob({ finalStatus: 'incomplete' });
  const incomplete = await client.callTool('deep_research_get', { id: await startJob(client), wait: true });
  assert.equal(incomplete.isError, false);
  assert.match(incomplete.text, /Note: the job ended as "incomplete": part of the research failed or the tool-call limit was reached/);
  assert.match(incomplete.text, /status: incomplete/);

  fake.scriptJob({ finalStatus: 'failed', error: { code: 'timeout', message: 'timeout' } });
  const failed = await client.callTool('deep_research_get', { id: await startJob(client), wait: true });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /^Deep Research job resp_\w+ failed: it ran past the time limit of about 25 minutes\./);

  fake.scriptJob({ finalStatus: 'failed', error: { code: 'internal', message: 'search backend unavailable' } });
  const failedOther = await client.callTool('deep_research_get', { id: await startJob(client), wait: true });
  assert.match(failedOther.text, /failed: search backend unavailable\./);

  fake.scriptJob({ finalStatus: 'cancelled' });
  const cancelled = await client.callTool('deep_research_get', { id: await startJob(client), wait: true });
  assert.equal(cancelled.isError, false);
  assert.match(cancelled.text, /was cancelled; there is no report/);
});

test('uses the most recent job of the project when no id is given', async (t) => {
  const { client } = await startServer(t);
  await startJob(client, { topic: '最初のテーマ' });
  const second = await startJob(client, { topic: '二つ目のテーマ' });

  const { text } = await client.callTool('deep_research_get', { wait: true });
  assert.match(text, new RegExp(`id: ${second} `));
});

test('jobs are remembered across server restarts, per project', async (t) => {
  const first = await startServer(t);
  const id = await startJob(first.client);
  await first.client.close();

  // Same data directory and API, same project: the job is found again.
  const sameProject = await startServer(t, { env: { CLAUDE_PLUGIN_DATA: first.dataDir, CLAUDE_PROJECT_DIR: first.projectDir, PLAMO_BASE_URL: first.fake.url } });
  const found = await sameProject.client.callTool('deep_research_get', {});
  assert.match(found.text, new RegExp(`id: ${id} `));

  // Another project sharing the data directory does not see it.
  const otherProject = await startServer(t, { env: { CLAUDE_PLUGIN_DATA: first.dataDir, PLAMO_BASE_URL: first.fake.url } });
  const missing = await otherProject.client.callTool('deep_research_get', {});
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No Deep Research job has been started from this project yet/);
});

test('starting a job is not repeated when nobody can tell whether it was started', async (t) => {
  const { client, fake } = await startServer(t);
  const starts = () => fake.requests.filter((request) => request.method === 'POST' && request.path === '/v1/responses').length;

  // A gateway timeout: the request may have reached PLaMo, and a second one would start, and bill, a second job.
  fake.failNext(1, 504, { detail: 'gateway timeout' }, { pathPrefix: '/v1/responses' });
  const lost = await client.callTool('deep_research_start', { topic: '調査テーマ' });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /HTTP 504\): gateway timeout\nThe PLaMo API is temporarily unavailable\. Try again later\. The request was not repeated automatically, because a second request could start, and bill, a second job\./);
  assert.match(lost.text, /PLaMo may have started this one all the same/);
  assert.equal(starts(), 1);
  assert.equal(fake.jobCount, 0);

  // A rate limit means the request was turned away, so it is sent again.
  fake.failNext(1, 429, { detail: 'rate limit exceeded' }, { pathPrefix: '/v1/responses' });
  await startJob(client);
  assert.equal(starts(), 3);
  assert.equal(fake.jobCount, 1);
});

test('rejects malformed and unknown job ids', async (t) => {
  const { client, fake } = await startServer(t);

  for (const id of ['../models', '.', '..', 'resp_1/cancel', 'a b']) {
    for (const tool of ['deep_research_get', 'deep_research_cancel']) {
      const malformed = await client.callTool(tool, { id });
      assert.equal(malformed.isError, true);
      assert.match(malformed.text, /is not a Deep Research job id/);
    }
  }
  assert.equal(fake.requests.length, 0, 'a malformed id never reaches the API');

  const unknown = await client.callTool('deep_research_get', { id: 'resp_00000000000000000000dead' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No Deep Research job with the id resp_00000000000000000000dead was found\. Results are deleted 24 hours after a job finishes/);
});

test('cancels a running job, and leaves a finished one alone', async (t) => {
  const { client, fake } = await startServer(t);

  fake.scriptJob({ pollsUntilDone: 100 });
  const running = await startJob(client);
  const cancelled = await client.callTool('deep_research_cancel', { id: running });
  assert.equal(cancelled.text, `Deep Research job ${running}: cancelled.`);
  assert.equal(fake.job(running).status, 'cancelled');

  const finished = await startJob(client);
  await client.callTool('deep_research_get', { id: finished, wait: true });
  const noop = await client.callTool('deep_research_cancel', { id: finished });
  assert.equal(noop.text, `Deep Research job ${finished} has already ended (status: completed); nothing was cancelled.`);
  assert.equal(fake.requests.filter((request) => request.path.endsWith('/cancel')).length, 1);
});

test('a cancelled wait stops following the job', async (t) => {
  const { client, fake } = await startServer(t);
  fake.scriptJob({ streamUnavailable: true, pollsUntilDone: 1_000_000 });
  const id = await startJob(client);

  let answered = false;
  client.request('tools/call', { name: 'deep_research_get', arguments: { id, wait: true } }, { id: 'wait-call' }).then(() => {
    answered = true;
  }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.notify('notifications/cancelled', { requestId: 'wait-call' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const requestsAfterCancel = fake.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(answered, false);
  assert.equal(fake.requests.length, requestsAfterCancel, 'polling stopped');
});
