// Unit tests for the small building blocks: SSE parsing, argument validation,
// result formatting, configuration, file-name screening and stored state.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cleanEnvValue, loadConfig } from '../plugins/plamo/server/lib/config.mjs';
import { createFileAccess, looksSensitive } from '../plugins/plamo/server/lib/files.mjs';
import { annotateCitations, collectSources, metaLine, preview, renderAttachments, renderSources } from '../plugins/plamo/server/lib/format.mjs';
import { extractErrorMessage, normaliseAnnotations } from '../plugins/plamo/server/lib/plamo-client.mjs';
import { validateArgs } from '../plugins/plamo/server/lib/schema.mjs';
import { parseSse } from '../plugins/plamo/server/lib/sse.mjs';
import { ConversationStore, ResearchJobStore } from '../plugins/plamo/server/lib/state.mjs';
import { createPlaceholders, languageCode, languageName, looksJapanese, structureOf, unwrapTranslation } from '../plugins/plamo/server/lib/tools/translate.mjs';
import { formatDuration, mapConcurrent } from '../plugins/plamo/server/lib/util.mjs';

async function collectSse(chunks) {
  async function* source() {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk);
  }
  const events = [];
  for await (const event of parseSse(source())) events.push(event);
  return events;
}

test('parseSse: events, comments, CRLF, multi-line data and missing final newline', async () => {
  assert.deepEqual(await collectSse([': open\n\nevent: a\ndata: {"x":1}\n\ndata: plain\n\n']), [
    { event: 'a', data: '{"x":1}' },
    { event: 'message', data: 'plain' },
  ]);
  assert.deepEqual(await collectSse(['data: one\r\ndata: two\r\n\r\n']), [{ event: 'message', data: 'one\ntwo' }]);
  assert.deepEqual(await collectSse(['data: no trailing blank line']), [{ event: 'message', data: 'no trailing blank line' }]);
  assert.deepEqual(await collectSse(['data:nospace\n\n', 'id: 7\nretry: 10\n\n']), [{ event: 'message', data: 'nospace' }]);
});

test('parseSse: events and multi-byte characters split across chunks', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"日本語"}\n\ndata: [DONE]\n\n');
  // Feed one byte at a time: every UTF-8 sequence and every line is split.
  async function* drip() {
    for (const byte of bytes) yield Uint8Array.of(byte);
  }
  const events = [];
  for await (const event of parseSse(drip())) events.push(event.data);
  assert.deepEqual(events, ['{"text":"日本語"}', '[DONE]']);
});

test('validateArgs: required, unknown, ranges and enums', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      ratio: { type: 'number', minimum: 0, maximum: 2 },
      mode: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 2 },
      flag: { type: 'boolean' },
      nested: { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false },
      free: { type: 'object' },
    },
    required: ['name'],
    additionalProperties: false,
  };
  const errorsFor = (input) => validateArgs(schema, input).errors;

  assert.deepEqual(errorsFor({ name: 'x' }), []);
  assert.deepEqual(errorsFor({}), ['missing required parameter "name"']);
  assert.deepEqual(errorsFor(undefined), ['missing required parameter "name"']);
  assert.deepEqual(errorsFor('nope'), ['arguments must be an object']);
  assert.deepEqual(errorsFor({ name: '' }), ['"name" must not be empty']);
  assert.deepEqual(errorsFor({ name: 'x', count: 0 }), ['"count" must be >= 1']);
  assert.deepEqual(errorsFor({ name: 'x', count: 1.5 }), ['"count" must be an integer']);
  assert.deepEqual(errorsFor({ name: 'x', ratio: 3 }), ['"ratio" must be <= 2']);
  assert.deepEqual(errorsFor({ name: 'x', mode: 'c' }), ['"mode" must be one of: "a", "b"']);
  assert.deepEqual(errorsFor({ name: 'x', tags: ['a', 'b', 'c'] }), ['"tags" must have at most 2 item(s)']);
  assert.deepEqual(errorsFor({ name: 'x', tags: ['ok', ''] }), ['"tags[1]" must not be empty']);
  assert.deepEqual(errorsFor({ name: 'x', flag: 'maybe' }), ['"flag" must be true or false']);
  assert.deepEqual(errorsFor({ name: 'x', nested: { town: 'y' } }), ['unknown parameter "nested.town" (allowed: city)']);
  assert.deepEqual(errorsFor({ name: 'x', nested: 'y' }), ['"nested" must be an object']);
  assert.match(errorsFor({ name: 'x', extra: 1 })[0], /^unknown parameter "extra" \(allowed: name, count,/);
});

test('validateArgs: coerces unambiguous values and drops nulls', () => {
  const schema = {
    type: 'object',
    properties: { count: { type: 'integer' }, ratio: { type: 'number' }, flag: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } }, free: { type: 'object' }, note: { type: 'string' } },
    additionalProperties: false,
  };
  const { value, errors } = validateArgs(schema, { count: ' 42 ', ratio: '0.5', flag: 'TRUE', tags: 'solo', free: { any: [1] }, note: null });
  assert.deepEqual(errors, []);
  assert.deepEqual(value, { count: 42, ratio: 0.5, flag: true, tags: ['solo'], free: { any: [1] } });
  assert.deepEqual(validateArgs(schema, { count: 'many' }).errors, ['"count" must be an integer']);
});

test('validateArgs: an empty string for an optional text parameter means it was left out', () => {
  const schema = {
    type: 'object',
    properties: { prompt: { type: 'string', minLength: 1 }, system: { type: 'string' }, output_file: { type: 'string', minLength: 1 }, count: { type: 'integer' } },
    required: ['prompt'],
    additionalProperties: false,
  };
  assert.deepEqual(validateArgs(schema, { prompt: 'p', system: '', output_file: '' }), { value: { prompt: 'p' }, errors: [] });
  assert.deepEqual(validateArgs(schema, { prompt: '' }).errors, ['"prompt" must not be empty'], 'a required one still has to be given');
  assert.deepEqual(validateArgs(schema, { prompt: 'p', count: '' }).errors, ['"count" must be an integer'], 'only text parameters');
});

test('validateArgs: parameter names that collide with built-in properties get no special treatment', () => {
  const strict = { type: 'object', properties: { prompt: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['prompt'], additionalProperties: false };
  // JSON.parse makes "__proto__" an own property, which is how it arrives over the wire.
  const hostile = JSON.parse('{"prompt":"hi","__proto__":{"overwrite":"yes","prompt":42}}');
  const result = validateArgs(strict, hostile);
  assert.deepEqual(result.errors, ['unknown parameter "__proto__" (allowed: prompt, overwrite)']);
  assert.equal(result.value.overwrite, undefined, 'nothing is inherited from the hostile object');
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.match(validateArgs(strict, { prompt: 'hi', [name]: 'x' }).errors[0], new RegExp(`^unknown parameter "${name}"`));
  }
  assert.deepEqual(validateArgs(strict, JSON.parse('{"__proto__":{"prompt":"smuggled"}}')).errors.sort(), ['missing required parameter "prompt"', 'unknown parameter "__proto__" (allowed: prompt, overwrite)']);

  // Where unknown parameters are allowed, "__proto__" is kept as an ordinary property.
  const loose = validateArgs({ type: 'object', properties: { a: { type: 'string' } } }, JSON.parse('{"a":"x","__proto__":{"polluted":true}}'));
  assert.deepEqual(loose.errors, []);
  assert.equal(loose.value.polluted, undefined);
  assert.equal(Object.getPrototypeOf(loose.value), Object.prototype);
  assert.deepEqual(Object.keys(loose.value), ['a', '__proto__']);
});

test('citations: numbering, markers at zero-width positions, and source lists', () => {
  const annotations = normaliseAnnotations([
    { type: 'url_citation', url_citation: { url: 'https://a', title: 'A', start_index: 2, end_index: 2 } },
    { type: 'url_citation', url: 'https://b', title: '', start_index: 2, end_index: 2 },
    { type: 'url_citation', url_citation: { url: 'https://a', title: 'A', start_index: 4, end_index: 4 } },
    { type: 'url_citation', url_citation: { url: 'https://c', title: 'C', start_index: 0, end_index: 3 } },
    { type: 'other' },
  ]);
  assert.equal(annotations.length, 4, 'both the nested and the flat form are understood; unknown entries are dropped');

  const { text, sources } = annotateCitations('一二三四', annotations);
  assert.equal(text, '一二[1][2]三四[1]');
  assert.deepEqual(sources, [
    { number: 1, url: 'https://a', title: 'A' },
    { number: 2, url: 'https://b', title: '' },
    { number: 3, url: 'https://c', title: 'C' },
  ]);
  assert.equal(renderSources(sources), 'Sources:\n[1] A - https://a\n[2] https://b\n[3] C - https://c');
  assert.equal(renderSources([]), '');
  assert.deepEqual(collectSources([]), []);
  assert.deepEqual(annotateCitations('text', []), { text: 'text', sources: [] });
  assert.deepEqual(normaliseAnnotations(null), []);
});

test('formatting helpers', () => {
  assert.equal(metaLine({ model: 'm', tokens: null, n: 0, skip: false, empty: '', note: 'x' }), '[PLaMo] model: m | n: 0 | note: x');
  assert.equal(preview('  short  '), 'short');
  assert.equal(preview(`${'line one is here\n'.repeat(10)}`, 60), 'line one is here\nline one is here\nline one is here\n…');
  assert.equal(preview(`ab${'😀'.repeat(10)}`, 5), 'ab😀\n…', 'never cut through the middle of a character');
  assert.equal(renderAttachments([]), '');
  assert.equal(renderAttachments([{ path: 'a.txt', text: 'x' }]), '\n\n--- Attached files (1) ---\n\nFile: a.txt\n```txt\nx\n```\n');
  assert.equal(formatDuration(5), '5s');
  assert.equal(formatDuration(125), '2m05s');
});

test('error bodies of every shape yield a readable message', () => {
  assert.equal(extractErrorMessage('{"detail":"model not found"}'), 'model not found');
  assert.equal(extractErrorMessage('{"message":"Unauthorized"}'), 'Unauthorized');
  assert.equal(extractErrorMessage('{"code":"not_found","message":"Response not found","details":[]}'), 'Response not found');
  assert.equal(extractErrorMessage('{"error":{"message":"openai style"}}'), 'openai style');
  assert.equal(extractErrorMessage('{"error":"flat"}'), 'flat');
  assert.equal(extractErrorMessage('{"detail":[{"loc":["body","model"],"msg":"field required"},"plain"]}'), 'model: field required; plain');
  assert.equal(extractErrorMessage('<html>Bad Gateway</html>'), '<html>Bad Gateway</html>');
  assert.equal(extractErrorMessage(''), '(empty response body)');
});

test('configuration: sources, precedence and defaults', () => {
  assert.equal(cleanEnvValue('  x  '), 'x');
  assert.equal(cleanEnvValue('${user_config.api_key}'), '');
  assert.equal(cleanEnvValue(undefined), '');

  const defaults = loadConfig({}, { cwd: '/work' });
  assert.equal(defaults.apiKey, '');
  assert.equal(defaults.apiKeySource, null);
  assert.equal(defaults.baseUrl, 'https://api.platform.preferredai.jp/v1');
  assert.equal(defaults.model, 'plamo-3.1-prime');
  assert.equal(defaults.deepResearchModel, 'plamo-3.1-prime-deep-research');
  assert.equal(defaults.projectDir, path.resolve('/work'));
  assert.deepEqual(defaults.allowedDirs, [path.resolve('/work')]);
  assert.equal(defaults.dataDir, null);
  assert.match(defaults.version, /^\d+\.\d+\.\d+$/);

  const configured = loadConfig({
    PLAMO_PLUGIN_OPTION_API_KEY: 'from-option',
    PLAMO_API_KEY: 'from-env',
    PLAMO_PLUGIN_OPTION_MODEL: '',
    PLAMO_MODEL: 'plamo-x',
    PLAMO_BASE_URL: 'http://localhost:8080/v1/',
    CLAUDE_PROJECT_DIR: '/project',
    CLAUDE_PLUGIN_DATA: '/data',
    PLAMO_ALLOWED_DIRS: ['/one', ' /two '].join(path.delimiter),
    PLAMO_DEBUG: '1',
  });
  assert.equal(configured.apiKey, 'from-option');
  assert.equal(configured.apiKeySource, 'plugin-option');
  assert.equal(configured.model, 'plamo-x');
  assert.equal(configured.baseUrl, 'http://localhost:8080/v1');
  assert.deepEqual(configured.allowedDirs, ['/project', '/one', '/two'].map((dir) => path.resolve(dir)));
  assert.equal(configured.dataDir, '/data');
  assert.equal(configured.debug, true);

  assert.equal(loadConfig({ PLAMO_API_KEY: 'k' }).apiKeySource, 'env');
  assert.throws(() => loadConfig({ PLAMO_BASE_URL: 'ftp://example.com' }), /must start with https:\/\/ or http:\/\//);
});

test('configuration: a key or a base URL that could leak is refused without being echoed', () => {
  assert.equal(loadConfig({ PLAMO_API_KEY: '  plamo-abc_123.XYZ\n' }).apiKeyProblem, null, 'whitespace around a key is trimmed');

  // A two-line file read into the variable, a pasted sentence, quotes from a document, a zero-width space.
  for (const key of ['plamo-abc\n# work key', 'plamo abc', '“plamo-abc”', `plamo-abc${String.fromCharCode(0x200b)}`, 'plamo-abc\tdef']) {
    const config = loadConfig({ PLAMO_API_KEY: key });
    assert.equal(config.apiKey, '', 'a malformed key is not used');
    assert.equal(config.apiKeySource, 'env', 'but it is known where it came from');
    assert.match(config.apiKeyProblem, /^The PLaMo API key is set but malformed/);
    assert.ok(!config.apiKeyProblem.includes('plamo-abc'), 'and it is not quoted');
  }

  for (const url of ['https://user:hunter2@proxy.example/v1', 'https://:hunter2@proxy.example/v1', 'https://user@proxy.example/v1']) {
    assert.throws(() => loadConfig({ PLAMO_BASE_URL: url }), (error) => /must not contain a user name or password/.test(error.message) && !error.message.includes('hunter2'));
  }
  // Whatever else is wrong with the value, one that may hold a password is not quoted in the message.
  for (const url of ['user:hunter2@not a url', 'https://user:hunter2@', 'ftp://user:hunter2@example.com/']) {
    assert.throws(() => loadConfig({ PLAMO_BASE_URL: url }), (error) => /^PLAMO_BASE_URL /.test(error.message) && !error.message.includes('hunter2'), url);
  }
  assert.throws(() => loadConfig({ PLAMO_BASE_URL: 'not a url' }), /PLAMO_BASE_URL is not a valid URL: not a url/);
});

test('files that look like credentials are recognised, source files are not', () => {
  const sensitive = [
    '.env', '.env.local', '.env.production', 'config/.ENV', 'id_rsa', 'id_ed25519_work', 'server.pem', 'tls.key', 'store.p12',
    '.netrc', '.npmrc', '.git-credentials', 'credentials.json', 'secrets.yaml', 'my-api-key.txt', 'plamo-prime-api-key.txt',
    'api_keys.json', 'password.txt', 'private-key.pem', 'access_token', '/home/me/.ssh/config', '/home/me/.aws/config',
  ];
  const harmless = [
    '.env.example', '.env.sample', 'id_rsa.pub', 'credentials_provider.ts', 'password_reset.py', 'secret_santa.md', 'api_key_validator.go',
    'tokenizer.py', 'keyboard.json', 'README.md', 'secretary.txt', 'docs/secrets-management.md', 'monkey.txt', 'environment.yml',
  ];
  for (const name of sensitive) assert.equal(looksSensitive(name), true, `${name} should be refused`);
  for (const name of harmless) assert.equal(looksSensitive(name), false, `${name} should be allowed`);

  // Other spellings of an environment file, infrastructure state, tool configuration with tokens in it,
  // copies and backups of any of these, and anything kept in a directory that is named for secrets.
  const alsoSensitive = [
    '.envrc', 'prod.env', '.env-local', '.env_production', '.dev.vars', 'secrets.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup',
    'prod.tfvars.json', 'service-account.json', 'token.json', '.git/config', '.docker/config.json', '.mcp.json', 'secrets.yaml.bak',
    'credentials.json.old', 'server.key.old', '.env~', 'secrets/db.txt', 'config/credentials/prod.txt', 'serviceAccountKey.json', 'auth.json',
    '.pgpass', '.my.cnf', '.vault-token', 'kubeconfig', 'kubeconfig.yaml', 'htpasswd', 'wallet.dat', 'keystore.json', '.bash_history', '.zsh_history',
  ];
  const alsoHarmless = [
    'docs/secrets.md', 'design-tokens.json', 'tokens.json', 'README.env.md', 'prod.env.example', 'notes.bak', 'src/credentials_provider.ts', 'gitconfig.md',
  ];
  for (const name of alsoSensitive) assert.equal(looksSensitive(name), true, `${name} should be refused`);
  for (const name of alsoHarmless) assert.equal(looksSensitive(name), false, `${name} should be allowed`);
});

test('file access: the directories above the project say nothing about a file', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-files-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  // A project that happens to live under a directory called "secrets".
  const root = path.join(base, 'secrets', 'project');
  await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(root, 'notes.md'), 'notes');
  await fs.writeFile(path.join(root, 'secrets', 'db.txt'), 'hunter2');
  await fs.writeFile(path.join(root, 'plain.txt'), 'plain');
  await fs.symlink(path.join(root, 'plain.txt'), path.join(root, '.env'));
  await fs.symlink(path.join(root, 'secrets', 'db.txt'), path.join(root, 'innocent.txt'));
  const files = createFileAccess({ projectDir: root, allowedDirs: [root] });

  assert.equal((await files.readText('notes.md')).text, 'notes');
  assert.equal((await files.readText(path.join(root, 'notes.md'))).text, 'notes');
  await assert.rejects(files.readText('secrets/db.txt'), /looks like it contains credentials/);
  await assert.rejects(files.readText('.env'), /looks like it contains credentials/, 'a link with the name of a credential file');
  await assert.rejects(files.readText('innocent.txt'), /looks like it contains credentials/, 'a link to a credential file');
});

test('file access: permissions are kept, and checked before any work is done', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-files-')));
  t.after(async () => {
    await fs.chmod(path.join(root, 'locked'), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const files = createFileAccess({ projectDir: root, allowedDirs: [root] });
  const modeOf = async (name) => (await fs.stat(path.join(root, name))).mode & 0o777;

  // A replaced file keeps its mode: a private file stays private, an executable one stays executable.
  for (const mode of [0o600, 0o755]) {
    await fs.writeFile(path.join(root, 'kept.md'), 'old');
    await fs.chmod(path.join(root, 'kept.md'), mode);
    await files.writeText('kept.md', 'new', { overwrite: true });
    assert.equal(await modeOf('kept.md'), mode);
    assert.equal(await fs.readFile(path.join(root, 'kept.md'), 'utf8'), 'new');
  }

  // Errors from the file system come back as messages, not as raw exceptions.
  await fs.symlink(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
  await fs.symlink(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
  await assert.rejects(files.resolveWritable('loop-a/out.md'), (error) => error.name === 'FileAccessError');
  await fs.symlink(path.join(root, 'nowhere'), path.join(root, 'dangling'));
  await assert.rejects(files.writeText('dangling/out.md', 'x'), (error) => error.name === 'FileAccessError');

  // The superuser can write anywhere, so the rest cannot be observed as root.
  if (process.getuid?.() === 0) return;
  await fs.mkdir(path.join(root, 'locked'));
  await fs.chmod(path.join(root, 'locked'), 0o555);
  await assert.rejects(files.resolveWritable('locked/out.md'), /locked\/out\.md cannot be written: the directory is read-only/);
  await assert.rejects(files.resolveWritable('locked/deeper/out.md'), /cannot be written: the directory is read-only/);
  await fs.chmod(path.join(root, 'kept.md'), 0o444);
  await assert.rejects(files.resolveWritable('kept.md', { overwrite: true }), /kept\.md cannot be written: the file or its directory is read-only/);
  assert.equal(await fs.readFile(path.join(root, 'kept.md'), 'utf8'), 'new', 'a read-only file is not replaced');
});

test('file access: encodings, size limit and atomic replacement', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-files-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = createFileAccess({ projectDir: root, allowedDirs: [root] });

  await fs.writeFile(path.join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('日本語')]));
  assert.equal((await files.readText('bom.txt')).text, '日本語', 'a UTF-8 byte order mark is dropped');

  await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('日本語', 'utf16le')]));
  assert.equal((await files.readText('utf16.txt')).text, '日本語', 'UTF-16 with a byte order mark is decoded');

  await fs.writeFile(path.join(root, 'sjis.txt'), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]));
  await assert.rejects(files.readText('sjis.txt'), /is not valid UTF-8 text\. Convert it to UTF-8 first/);

  await fs.writeFile(path.join(root, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  await assert.rejects(files.readText('huge.txt'), /is too large/);

  await fs.writeFile(path.join(root, 'part.txt'), 'x'.repeat(600_000));
  await fs.writeFile(path.join(root, 'part2.txt'), 'y'.repeat(600_000));
  await assert.rejects(files.readAll(['part.txt', 'part2.txt']), /too large together/);

  const written = await files.writeText('out/result.md', 'first');
  assert.deepEqual({ path: written.path, bytes: written.bytes, replaced: written.replaced }, { path: path.join('out', 'result.md'), bytes: 5, replaced: false });
  await assert.rejects(files.writeText('out/result.md', 'second'), /already exists/);
  const replaced = await files.writeText('out/result.md', 'second', { overwrite: true });
  assert.equal(replaced.replaced, true);
  assert.equal(await fs.readFile(path.join(root, 'out', 'result.md'), 'utf8'), 'second');
  assert.deepEqual(await fs.readdir(path.join(root, 'out')), ['result.md'], 'no temporary file is left behind');

  // A symlinked directory that leads out of the project is not a way out.
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-outside-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'escape'));
  await assert.rejects(files.writeText('escape/file.md', 'x'), /outside the project directory/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('conversation store evicts the least recently used conversation', () => {
  const store = new ConversationStore({ limit: 2 });
  const a = store.save(undefined, [{ role: 'user', content: 'a' }]);
  const b = store.save(undefined, [{ role: 'user', content: 'b' }]);
  assert.match(a, /^c_[0-9a-f]{8}$/);
  store.get(a); // touch a, so b is now the oldest
  const c = store.save(undefined, [{ role: 'user', content: 'c' }]);

  assert.equal(store.get(b), undefined);
  assert.deepEqual(store.get(a), [{ role: 'user', content: 'a' }]);
  assert.deepEqual(store.get(c), [{ role: 'user', content: 'c' }]);

  const copy = store.get(a);
  copy.push({ role: 'user', content: 'mutated' });
  assert.equal(store.get(a).length, 1, 'callers get a copy');
});

test('research job store survives a missing directory, a corrupt file and its own limit', async (t) => {
  const dataDir = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-jobs-'))), 'not', 'yet', 'there');
  t.after(() => fs.rm(path.resolve(dataDir, '..', '..', '..'), { recursive: true, force: true }));
  const store = new ResearchJobStore({ dataDir, projectDir: '/p', limit: 3 });

  assert.deepEqual(await store.recent(), []);
  for (const id of ['resp_1', 'resp_2', 'resp_3', 'resp_4']) await store.add({ id, topic: 't'.repeat(500), createdAt: '2026-11-19T00:00:00Z' });
  const recent = await store.recent();
  assert.deepEqual(recent.map((job) => job.id), ['resp_4', 'resp_3', 'resp_2'], 'newest first, oldest dropped');
  assert.equal(recent[0].topic.length, 200, 'long topics are shortened');

  await store.setStatus('resp_4', 'completed');
  assert.equal((await store.recent())[0].status, 'completed');

  await fs.writeFile(path.join(dataDir, 'research-jobs.json'), '{ not json');
  assert.deepEqual((await store.recent()).map((job) => job.id), ['resp_4', 'resp_3', 'resp_2'], 'with a corrupt file, the store goes by what it remembers');
  assert.deepEqual(await new ResearchJobStore({ dataDir, projectDir: '/p' }).recent(), [], 'and a new process starts from nothing');

  const memoryOnly = new ResearchJobStore({ dataDir: null, projectDir: '/p' });
  await memoryOnly.add({ id: 'resp_m', topic: 't', createdAt: 'now' });
  assert.deepEqual((await memoryOnly.recent()).map((job) => job.id), ['resp_m']);
});

test('research job store keeps every change when several arrive at once', async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-jobs-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const job = (id) => ({ id, topic: 't', createdAt: 'now' });

  for (const store of [new ResearchJobStore({ dataDir, projectDir: '/p' }), new ResearchJobStore({ dataDir: null, projectDir: '/p' })]) {
    await Promise.all([store.add(job('resp_a')), store.add(job('resp_b')), store.add(job('resp_c'))]);
    await Promise.all([store.setStatus('resp_a', 'completed'), store.setStatus('resp_c', 'failed')]);
    assert.deepEqual((await store.recent()).map((entry) => `${entry.id}:${entry.status}`), ['resp_c:failed', 'resp_b:queued', 'resp_a:completed']);
  }
  assert.deepEqual((await fs.readdir(dataDir)).sort(), ['research-jobs.json'], 'no temporary file is left behind');

  // A data directory that cannot be created (its parent is a file): the jobs are still remembered for this process.
  await fs.writeFile(path.join(dataDir, 'blocker'), '');
  const stranded = new ResearchJobStore({ dataDir: path.join(dataDir, 'blocker', 'data'), projectDir: '/p' });
  await stranded.add(job('resp_s'));
  assert.deepEqual((await stranded.recent()).map((entry) => entry.id), ['resp_s']);
});

test('translation helpers', () => {
  assert.equal(languageName(' JA '), 'Japanese');
  assert.equal(languageName('英語'), 'English');
  assert.equal(languageName('zh-TW'), 'Chinese (Traditional)');
  assert.equal(languageName('english'), 'English');
  assert.equal(languageName('Swahili'), 'Swahili');
  assert.equal(languageCode('Japanese'), 'ja');
  assert.equal(languageCode('Chinese (Traditional)'), 'zh-TW');
  assert.equal(languageCode('Brazilian Portuguese'), 'brazilian-portuguese');
  assert.equal(languageCode('한국어'), 'translated', 'a name without ASCII letters still gives a usable file name part');

  assert.equal(looksJapanese('これは日本語の文章です。'), true);
  assert.equal(looksJapanese('Claude Code の plugin を install する'), true);
  assert.equal(looksJapanese('This is English.'), false);
  assert.equal(looksJapanese('这是中文。漢字只有'), false);
  assert.equal(looksJapanese('保存配置文件后，需要重新启动服务器才能生效。'), false, 'a long text in Chinese characters only is Chinese');
  assert.equal(looksJapanese('利用規約'), true, 'a short one may be a Japanese term, and is taken for one');
  assert.equal(looksJapanese('The 利用規約 page'), false);
  assert.equal(looksJapanese('```\nコメントだけ日本語\n```\nEnglish prose with `日本語のコード` inline.'), false, 'code is ignored');
  assert.equal(looksJapanese('12345 !?'), false);

  const document = [
    '# Title',
    '',
    'Intro with **bold** and a | pipe in the middle.',
    '',
    '## Section',
    '',
    '- one',
    '  - nested',
    '* star',
    '1. numbered',
    '2) also numbered',
    '**not a list item**',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```sh',
    '# not a heading',
    '- not a list item',
    '| not | a | table |',
    '```',
    '',
    '~~~',
    'second block',
    '~~~',
  ].join('\n');
  assert.deepEqual(structureOf(document), {
    'code blocks': 2,
    'unclosed code fences': 0,
    headings: 2,
    'table rows': 3,
    'list items': 5,
    links: 0,
    'inline code spans': 0,
    'blockquote paragraphs': 0,
    paragraphs: 2,
  });
  assert.deepEqual(structureOf('See [a](x), ![img](y) and `one` or `two`.\n\n```\nnever closed [b](z) `c`'), {
    'code blocks': 0,
    'unclosed code fences': 1,
    headings: 0,
    'table rows': 0,
    'list items': 0,
    links: 2,
    'inline code spans': 2,
    'blockquote paragraphs': 0,
    paragraphs: 1,
  });

  // Paragraphs of running text: what a translation keeps even when it wraps lines differently or adds blank lines.
  const paragraphs = (text) => structureOf(text).paragraphs;
  const wrapped = '# Title\nIntro that is\nwrapped over lines.\n## Next\n- item\n  continued item\nText right under the list.\n\n| a | b |\n|---|---|\nText under a table.\n> quote\n\nLast one.\n';
  const reflowed = '# Title\n\nIntro that is wrapped over lines.\n\n## Next\n\n- item continued item\n\nText right under the list.\n\n| a | b |\n|---|---|\n\nText under a table.\n\n> quote\n\nLast one.\n';
  assert.equal(paragraphs(wrapped), 4);
  assert.equal(paragraphs(reflowed), 4, 'wrapping and blank lines make no difference');
  assert.equal(paragraphs(wrapped.replace('Last one.\n', '')), 3, 'a dropped paragraph does');
  assert.equal(paragraphs(wrapped.replace('\n\nLast one.', '\n> Last one.')), 3, 'and so does one pulled into the quote before it');
  assert.equal(paragraphs('Title\n=====\n\n---\n\n***\n'), 1, 'rules and underlines are not text');
  assert.equal(structureOf('text\n~~~~\nmore\n~~~~\nend', { fences: false }).paragraphs, 3, 'without fences, a line of tildes is a rule between paragraphs');

  // Japanese plain text marks list items with bullets and circled numbers; a translation may turn them into "- " and "1. ".
  const items = (text) => structureOf(text)['list items'];
  assert.equal(items('・一つ目\n・二つ目\n① 手順\n② 手順\n● 項目'), 5);
  assert.equal(items('- first\n- second\n1. step\n2. step\n- item'), 5);
  assert.equal(items('2019. That year the project began.\n-not an item\n1.5 is a number'), 0);

  // Quoted paragraphs are counted, not quoted lines, so a re-wrapped paragraph does not count as a change...
  const quoted = (text) => structureOf(text)['blockquote paragraphs'];
  assert.equal(quoted('> [!NOTE]\n> one\n> two\n>\n> three\n\nplain\n\n  > > nested'), 3);
  assert.equal(quoted('> [!NOTE]\n> one two\n>\n> three\n\nplain\n\n  > > nested'), 3);
  // ...while a paragraph that was pulled into the quote does.
  assert.equal(quoted('> [!NOTE]\n> one\n> two\n>\n> three\n>\n> plain\n\n  > > nested'), 4);
  assert.equal(quoted('```\n> not a quote\n```'), 0);

  const placeholders = createPlaceholders('ordinary text');
  const source = 'Intro\n\n```sh\nls\n```\n\n- item\n  ~~~\n  nested\n  ~~~\n\nEnd';
  const { masked, blocks } = placeholders.mask(source);
  assert.equal(masked, 'Intro\n\n{{PLAMO_CODE_BLOCK_1}}\n\n- item\n  {{PLAMO_CODE_BLOCK_2}}\n\nEnd');
  assert.deepEqual(blocks, [
    { before: '', code: '```sh\nls\n```' },
    { before: '  ', code: '~~~\n  nested\n  ~~~' },
  ]);
  assert.equal(placeholders.unmask(masked, blocks), source, 'masking and unmasking is lossless');
  // The line of a placeholder is rebuilt from the original, whatever the translation did to its indentation.
  assert.equal(placeholders.unmask('{{PLAMO_CODE_BLOCK_2}}\n    {{PLAMO_CODE_BLOCK_1}}  \n{{PLAMO_CODE_BLOCK_9}}', blocks), '  ~~~\n  nested\n  ~~~\n```sh\nls\n```\n{{PLAMO_CODE_BLOCK_9}}');

  // A block that opens on the line of a list marker leaves the marker in the text.
  const listed = placeholders.mask('1. ```sh\n   ls\n   ```\n2. next');
  assert.equal(listed.masked, '1. {{PLAMO_CODE_BLOCK_1}}\n2. next');
  assert.deepEqual(listed.blocks, [{ before: '1. ', code: '```sh\n   ls\n   ```' }]);
  assert.equal(placeholders.intact(listed.masked, '1. {{PLAMO_CODE_BLOCK_1}}\n2. 次'), true);
  assert.equal(placeholders.intact(listed.masked, '1. 次の {{PLAMO_CODE_BLOCK_1}}\n2. 次'), false, 'text beside the placeholder');
  assert.equal(placeholders.unmask('1) {{PLAMO_CODE_BLOCK_1}}\n2. 次', listed.blocks), '1. ```sh\n   ls\n   ```\n2. 次');
  assert.deepEqual(placeholders.split('a\n1. {{PLAMO_CODE_BLOCK_1}}\nb'), ['a\n', '1. {{PLAMO_CODE_BLOCK_1}}', '\nb']);
  assert.equal(placeholders.sequence(masked), '1,2');
  assert.equal(placeholders.intact(masked, masked.toUpperCase()), true);
  assert.equal(placeholders.intact(masked, masked.replace('{{PLAMO_CODE_BLOCK_2}}', '')), false, 'one is missing');
  assert.equal(placeholders.intact(masked, `${masked}\n{{PLAMO_CODE_BLOCK_1}}`), false, 'one is repeated');
  assert.equal(placeholders.intact(masked, masked.replace('\n\n{{PLAMO_CODE_BLOCK_1}}\n\n', ' {{PLAMO_CODE_BLOCK_1}} ')), false, 'one is not on its own line');
  assert.deepEqual(placeholders.split('a\n{{PLAMO_CODE_BLOCK_1}}\nb\n  {{PLAMO_CODE_BLOCK_2}}'), ['a\n', '{{PLAMO_CODE_BLOCK_1}}', '\nb\n', '  {{PLAMO_CODE_BLOCK_2}}', '']);
  assert.equal(placeholders.strip('x {{PLAMO_CODE_BLOCK_3}} y'), 'x  y');
  assert.equal(createPlaceholders('mentions PLAMO_CODE_BLOCK and PLAMO_CODE_BLOCK_X too').example, '{{PLAMO_CODE_BLOCK_X_X_1}}');

  assert.equal(unwrapTranslation('  訳文  ', 'source'), '訳文');
  assert.equal(unwrapTranslation('<source_text>\n訳文\n</source_text>', 'source'), '訳文');
  assert.equal(unwrapTranslation('<source_text>訳文', 'source'), '訳文');
  assert.equal(unwrapTranslation('```md\n訳文\n```', 'source'), '訳文');
  assert.equal(unwrapTranslation('```sh\nls\n```', '```sh\nls\n```'), '```sh\nls\n```', 'a real code block is kept');
  assert.equal(unwrapTranslation('```python\nprint(1)\n```', 'source'), '```python\nprint(1)\n```', 'only prose fences count as wrappers');
});

test('mapConcurrent keeps order, limits concurrency and stops on failure', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent([30, 5, 20, 1, 10], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapConcurrent([], 3, async () => 1), []);

  let started = 0;
  await assert.rejects(
    mapConcurrent([1, 2, 3, 4, 5, 6], 1, async (item) => {
      started += 1;
      if (item === 2) throw new Error('boom');
      return item;
    }),
    /boom/,
  );
  assert.equal(started, 2, 'nothing new starts after a failure');
});
