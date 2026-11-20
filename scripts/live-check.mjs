#!/usr/bin/env node
// Live check: drive the real MCP server against the real PLaMo API.
//
//   PLAMO_API_KEY=... node scripts/live-check.mjs
//
// It costs a little: a few thousand tokens, plus one web search answer (one
// to three billed searches). Options, as environment variables:
//
//   PLAMO_LIVE_SKIP_WEB_SEARCH=1   leave out the web search
//   PLAMO_LIVE_DEEP_RESEARCH=1     also run a small Deep Research job
//                                  (a few billed searches, about a minute)
//   PLAMO_BASE_URL, PLAMO_MODEL    as for the plugin itself
//
// The key is only passed to the server process; it is never printed.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpTestClient } from '../tests/helpers/mcp-client.mjs';

const apiKey = (process.env.PLAMO_API_KEY ?? '').trim();
if (!apiKey) {
  console.error('Set PLAMO_API_KEY to run the live check.');
  process.exit(2);
}

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-live-')));
const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-live-data-')));
const env = {
  PLAMO_API_KEY: apiKey,
  CLAUDE_PROJECT_DIR: projectDir,
  CLAUDE_PLUGIN_DATA: dataDir,
  ...(process.env.PLAMO_BASE_URL ? { PLAMO_BASE_URL: process.env.PLAMO_BASE_URL } : {}),
  ...(process.env.PLAMO_MODEL ? { PLAMO_MODEL: process.env.PLAMO_MODEL } : {}),
};

const results = [];
const clip = (text, length = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

async function step(name, run) {
  const startedAt = Date.now();
  try {
    const note = await run();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)${note ? `\n      ${clip(note)}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${clip(String(error?.message ?? error), 600)}`);
  }
}

/** Call a tool and fail the step if the tool reports an error. */
async function call(client, name, args, options) {
  const result = await client.callTool(name, args, options);
  assert.equal(result.isError, false, `${name} returned an error: ${result.text}`);
  return result;
}

const legacy = new McpTestClient({ era: 'legacy', env, cwd: projectDir });
await step('legacy handshake (initialize) and status', async () => {
  const hello = await legacy.connect();
  assert.equal(hello.result.serverInfo.name, 'plamo');
  const { text } = await call(legacy, 'status');
  assert.match(text, /Connection: OK/);
  return text.split('\n').find((line) => line.includes('Connection'));
});
await legacy.close();

const client = new McpTestClient({ era: 'modern', env, cwd: projectDir });
await step('modern protocol (server/discover) lists the tools', async () => {
  const hello = await client.connect();
  assert.deepEqual(hello.result.supportedVersions, ['2026-07-28']);
  const { result } = await client.request('tools/list');
  return result.tools.map((tool) => tool.name).join(', ');
});

let conversationId;
await step('chat: a question in Japanese', async () => {
  const { text } = await call(client, 'chat', { prompt: '「吾輩は猫である」の作者は誰ですか？名前だけ答えてください。' }, { progressToken: 'chat-1' });
  assert.match(text, /夏目漱石/);
  conversationId = /conversation_id: (c_[0-9a-f]+)/.exec(text)[1];
  return text;
});

await step('chat: a follow-up in the same conversation', async () => {
  const { text } = await call(client, 'chat', { prompt: 'その人の代表作を、他に一つだけ挙げてください。', conversation_id: conversationId });
  assert.match(text, new RegExp(`conversation_id: ${conversationId}`));
  assert.match(text, /坊っちゃん|坊ちゃん|こころ|こゝろ|三四郎|草枕|それから|門|明暗|道草|虞美人草|行人|彼岸過迄/, 'the follow-up was understood in context');
  return text;
});

await step('chat: reasoning mode', async () => {
  const { text } = await call(client, 'chat', { prompt: '3人が1列に並ぶ並び方は何通りですか？数字だけ答えてください。', reasoning: true, max_tokens: 3000 });
  assert.match(text, /6/);
  assert.match(text, /of them reasoning/, 'reasoning tokens are reported');
  return text;
});

await step('chat: structured output', async () => {
  const schema = {
    type: 'object',
    properties: { prefecture: { type: 'string' }, capital: { type: 'string' } },
    required: ['prefecture', 'capital'],
    additionalProperties: false,
  };
  const { result } = await call(client, 'chat', { prompt: '北海道の道庁所在地は？', json_schema: schema });
  const data = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(data).sort(), ['capital', 'prefecture']);
  assert.match(data.capital, /札幌/);
  return JSON.stringify(data);
});

await step('chat: an attached file, answer saved to a file', async () => {
  await fs.writeFile(path.join(projectDir, 'notes.md'), '# 議事メモ\n\n- 次回の定例は 12 月 3 日（木）15 時から。\n- 担当: 佐藤さんが議題をまとめる。\n');
  const { text } = await call(client, 'chat', { prompt: '添付の議事メモから、次回の定例の日時だけを1行で答えてください。', files: ['notes.md'], output_file: 'out/answer.txt' });
  const saved = await fs.readFile(path.join(projectDir, 'out', 'answer.txt'), 'utf8');
  assert.match(saved, /12\s*月\s*3\s*日/);
  assert.match(text, /^Saved PLaMo's answer to out\/answer\.txt/);
  return saved;
});

await step('count_tokens', async () => {
  const { text } = await call(client, 'count_tokens', { text: 'こんにちは、世界！ Hello, world!' });
  assert.match(text, /^8 tokens/);
  return text.split('\n')[0];
});

await step('translate: a short text, direction chosen automatically', async () => {
  const { text } = await call(client, 'translate', { text: '設定ファイルは `config.yaml` に保存されます。' });
  assert.match(text, /config\.yaml/);
  assert.match(text, /translated into: English \(chosen automatically\)/);
  assert.match(text.split('\n')[0], /^[\x20-\x7e]+$/, 'the translation is English');
  return text;
});

await step('translate: a Markdown file in several parts, structure preserved', async () => {
  const section = (index) =>
    `## 手順 ${index}\n\n設定ファイル \`config-${index}.yaml\` を開き、次の値を変更します。変更後はサービスを再起動してください。` +
    `詳しくは[公式ドキュメント](https://example.com/docs/${index})を参照してください。\n\n` +
    `\`\`\`bash\n# 手順 ${index} のサービスを再起動する\nsystemctl restart service-${index}\n\`\`\`\n\n` +
    `| 項目 | 値 |\n|---|---|\n| タイムアウト | ${index * 10} 秒 |\n\n` +
    `${'この手順では、運用上の注意点をいくつか確認しておく必要があります。'.repeat(8)}\n\n`;
  const source = `# 運用ガイド\n\n${Array.from({ length: 24 }, (_, index) => section(index + 1)).join('')}`;
  await fs.writeFile(path.join(projectDir, 'guide.md'), source);

  const { text, progress } = await call(client, 'translate', { input_file: 'guide.md', output_file: 'guide.{lang}.md' }, { progressToken: 'tr-1' });
  const translated = await fs.readFile(path.join(projectDir, 'guide.en.md'), 'utf8');
  const parts = Number(/parts: (\d+)/.exec(text)[1]);
  assert.ok(parts >= 2, `the document was split, got ${parts} part(s)`);
  assert.doesNotMatch(text, /warning/);

  const count = (pattern, value) => (value.match(pattern) ?? []).length;
  assert.equal(count(/^## /gm, translated), 24, 'every section heading survived');
  assert.equal(count(/^```bash$/gm, translated), 24, 'every code block survived');
  assert.equal(count(/^\|---\|---\|$/gm, translated), 24, 'every table survived');
  for (let index = 1; index <= 24; index += 1) {
    assert.ok(translated.includes(`# 手順 ${index} のサービスを再起動する\nsystemctl restart service-${index}\n`), `code block ${index} is byte-identical to the original`);
    assert.ok(translated.includes(`](https://example.com/docs/${index})`), `link ${index} is intact`);
    assert.ok(translated.includes(`\`config-${index}.yaml\``), `inline code ${index} is intact`);
  }
  const prose = translated.replace(/```[\s\S]*?```/g, '');
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu, prose);
  assert.ok(kana < 20, `the prose is in English (found ${kana} kana characters outside code)`);
  assert.ok(translated.endsWith('\n') && !translated.endsWith('\n\n\n'), 'the end of the file is preserved');
  return `${parts} parts, ${source.length} -> ${translated.length} characters; progress: ${progress.at(-1)}`;
});

await step('translate: comments inside code blocks, on request', async () => {
  const source = '次のコマンドを実行します。\n\n```bash\n# 依存関係をインストールする\nnpm install\n```\n';
  const { result } = await call(client, 'translate', { text: source, target_language: 'en', translate_code_comments: true });
  const translated = result.content[0].text;
  assert.match(translated, /```bash\n# [^\n]*[A-Za-z][^\n]*\nnpm install\n```/, 'the comment is translated and the command is untouched');
  assert.doesNotMatch(translated, /[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'no Japanese is left');
  return translated;
});

if (process.env.PLAMO_LIVE_SKIP_WEB_SEARCH === '1') {
  console.log('SKIP  web_search (PLAMO_LIVE_SKIP_WEB_SEARCH=1)');
} else {
  await step('web_search: an answer with numbered sources', async () => {
    const { text } = await call(client, 'web_search', { query: 'Preferred Networks の本社はどこにありますか？1文で答えてください。', context_size: 'low' });
    assert.match(text, /Sources:\n\[1\] /);
    assert.match(text, /web searches: [1-9]/);
    assert.match(text, /大手町|千代田/);
    return text;
  });
}

if (process.env.PLAMO_LIVE_DEEP_RESEARCH === '1') {
  let jobId;
  await step('deep_research: start, wait with progress, report', async () => {
    const started = await call(client, 'deep_research_start', {
      topic: '富士山の標高と、その値がいつどのように測定されたものかを、国土地理院の情報にもとづいて簡潔にまとめてください。',
      allowed_domains: ['gsi.go.jp'],
      max_tool_calls: 5,
    });
    jobId = /job started: (resp_\w+)/.exec(started.text)[1];
    const { text, progress } = await call(client, 'deep_research_get', { id: jobId, wait: true, output_file: 'report.md' }, { progressToken: 'dr-1' });
    const report = await fs.readFile(path.join(projectDir, 'report.md'), 'utf8');
    assert.match(report, /3,?776/);
    assert.match(text, /status: (completed|incomplete)/);
    assert.ok(progress.length > 0, 'progress was reported');
    return `${jobId}: ${report.length} characters; progress such as "${progress[Math.floor(progress.length / 2)]}"`;
  });
  await step('deep_research: start and cancel', async () => {
    const started = await call(client, 'deep_research_start', { topic: '日本の主要な山の標高の一覧', max_tool_calls: 3 });
    const id = /job started: (resp_\w+)/.exec(started.text)[1];
    const { text } = await call(client, 'deep_research_cancel', { id });
    assert.match(text, /cancelled/);
    return text;
  });
} else {
  console.log('SKIP  deep_research (set PLAMO_LIVE_DEEP_RESEARCH=1 to include it)');
}

await step('the server wrote nothing unexpected', async () => {
  assert.deepEqual(client.garbage, [], 'stdout carries only protocol messages');
  assert.ok(!client.stderr.includes(apiKey), 'the key does not appear on stderr');
});

await client.close();
await fs.rm(projectDir, { recursive: true, force: true });
await fs.rm(dataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} live checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
