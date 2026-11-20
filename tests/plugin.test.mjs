// Consistency of the plugin as a whole: manifests, the MCP server entry, and
// the skills, checked against the tools the server really offers. These are
// the mistakes `claude plugin validate` cannot see, such as a skill that
// pre-approves a tool that does not exist.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../plugins/plamo/server/lib/config.mjs';
import { createTools } from '../plugins/plamo/server/lib/tools/index.mjs';
import { PLUGIN_ROOT, REPO_ROOT } from './helpers/mcp-client.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
const marketplace = readJson(path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
const mcp = readJson(path.join(PLUGIN_ROOT, '.mcp.json'));

const SERVER_NAME = Object.keys(mcp.mcpServers)[0];
/** How Claude Code names a tool of a plugin's MCP server. */
const TOOL_PREFIX = `mcp__plugin_${manifest.name}_${SERVER_NAME}__`;

const toolNames = createTools({ client: {}, config: loadConfig({}), files: {}, conversations: {}, jobs: {} }).map((tool) => tool.name);

function readSkills() {
  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  return fs.readdirSync(skillsDir).map((directory) => {
    const file = path.join(skillsDir, directory, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    assert.ok(match, `${file} starts with YAML frontmatter`);
    const frontmatter = {};
    for (const line of match[1].split('\n')) {
      const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      assert.ok(field, `${file}: frontmatter line is "key: value": ${line}`);
      frontmatter[field[1]] = field[2].replace(/^"(.*)"$/, '$1');
    }
    return { directory, file, frontmatter, body: match[2], text };
  });
}

const skills = readSkills();
const commandNames = skills.filter((skill) => skill.frontmatter['user-invocable'] !== 'false').map((skill) => `/${manifest.name}:${skill.frontmatter.name}`);

/** Every text that reaches a user or the model and may mention a command or a tool. */
function userFacingTexts() {
  const sources = skills.map((skill) => [skill.file, skill.text]);
  sources.push([path.join(REPO_ROOT, 'README.md'), fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')]);
  sources.push([path.join(PLUGIN_ROOT, 'README.md'), fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8')]);
  for (const file of ['server/index.mjs', 'server/lib/tools/utility.mjs', 'server/lib/plamo-client.mjs']) {
    sources.push([path.join(PLUGIN_ROOT, file), fs.readFileSync(path.join(PLUGIN_ROOT, file), 'utf8')]);
  }
  return sources;
}

test('the manifest names the plugin and versions agree everywhere', () => {
  assert.equal(manifest.name, 'plamo');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(readJson(path.join(REPO_ROOT, 'package.json')).version, manifest.version, 'package.json and plugin.json carry the same version');
  assert.equal(loadConfig({}).version, manifest.version, 'the server reports the manifest version');
  assert.ok(new URL(manifest.homepage), 'homepage is a URL');
});

test('the marketplace lists the plugin from its directory', () => {
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, manifest.name, 'the entry name and the manifest name are the same');
  assert.equal(path.resolve(REPO_ROOT, entry.source), PLUGIN_ROOT);
  assert.equal(entry.version, undefined, 'the version lives in plugin.json only');
});

test('the plugin has an icon the plugin directory accepts', () => {
  // The directory takes a square PNG of 512 to 2048 px on each side, under 2 MB,
  // and `claude plugin validate` checks none of that. It finds the file by this
  // path, so the manifest needs no `icon` field, which Claude Code before
  // v2.1.281 reports as unknown.
  const icon = fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'icon.png'));
  assert.equal(icon.toString('latin1', 0, 8), '\x89PNG\r\n\x1a\n', 'a PNG file');
  assert.equal(icon.toString('latin1', 12, 16), 'IHDR');
  const [width, height] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
  assert.equal(width, height, 'square');
  assert.ok(width >= 512 && width <= 2048, `${width} px on each side`);
  assert.ok(icon.length < 2_000_000, 'under 2 MB');
  assert.equal(manifest.icon, undefined);
});

test('the MCP server entry points at the server and only uses declared options', () => {
  const server = mcp.mcpServers[SERVER_NAME];
  assert.equal(server.command, 'node');
  const entry = server.args[0].replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
  assert.ok(fs.existsSync(entry), `${entry} exists`);

  const configSource = fs.readFileSync(path.join(PLUGIN_ROOT, 'server', 'lib', 'config.mjs'), 'utf8');
  for (const [variable, value] of Object.entries(server.env)) {
    const option = /^\$\{user_config\.([a-z_]+)\}$/.exec(value);
    assert.ok(option, `${variable} is filled from a plugin option`);
    assert.ok(option[1] in manifest.userConfig, `userConfig declares "${option[1]}"`);
    assert.ok(configSource.includes(`env.${variable}`), `the server reads ${variable}`);
  }
  assert.equal(manifest.userConfig.api_key.sensitive, true, 'the API key is stored as a secret');
  assert.equal(manifest.userConfig.api_key.required, undefined, 'the key is optional, because PLAMO_API_KEY works too');
});

test('every skill has a name matching its directory and a description', () => {
  assert.deepEqual(skills.map((skill) => skill.directory).sort(), ['api-guide', 'ask', 'proofread', 'research', 'search', 'setup', 'translate']);
  for (const { directory, frontmatter, body } of skills) {
    assert.equal(frontmatter.name, directory);
    assert.ok(frontmatter.description.length >= 20 && frontmatter.description.length <= 1536, `${directory}: description length`);
    assert.doesNotMatch(frontmatter.description, /[<>]/, `${directory}: no angle brackets in the description`);
    assert.ok(body.trim().length > 200, `${directory}: has instructions`);
  }
});

test('command skills are user-invoked and pre-approve only tools that exist', () => {
  for (const { directory, frontmatter, body } of skills) {
    if (directory === 'api-guide') {
      assert.equal(frontmatter['disable-model-invocation'], undefined, 'the API guide is for Claude to pick up on its own');
      continue;
    }
    assert.equal(frontmatter['disable-model-invocation'], 'true', `${directory} runs only when the user asks`);
    const allowed = frontmatter['allowed-tools'].split(/,\s*/);
    const mcpTools = allowed.filter((tool) => tool.startsWith('mcp__'));
    assert.ok(mcpTools.length > 0, `${directory} pre-approves the tools it needs`);
    for (const tool of mcpTools) {
      assert.ok(tool.startsWith(TOOL_PREFIX), `${directory}: ${tool} belongs to this plugin's server`);
      assert.ok(toolNames.includes(tool.slice(TOOL_PREFIX.length)), `${directory}: ${tool} exists`);
      assert.ok(body.includes(tool), `${directory}: the instructions use ${tool}`);
    }
    // Arguments must reach the instructions, except for the command that takes none.
    assert.equal(body.includes('$ARGUMENTS'), directory !== 'setup', `${directory}: $ARGUMENTS`);
  }
});

test('texts only mention tools and commands that exist', () => {
  for (const [file, text] of userFacingTexts()) {
    for (const [, tool] of text.matchAll(/mcp__plugin_[a-z]+_[a-z]+__([a-z_]+)/g)) {
      assert.ok(toolNames.includes(tool), `${file} mentions the tool "${tool}"`);
    }
    for (const [command] of text.matchAll(/\/plamo:[a-z-]+/g)) {
      assert.ok(commandNames.includes(command), `${file} mentions the command ${command}`);
    }
  }
});

test('the README documents every command and every tool', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  for (const command of commandNames) assert.ok(readme.includes(command), `README mentions ${command}`);
  for (const tool of toolNames) assert.ok(readme.includes(`\`${tool}\``), `README mentions the tool ${tool}`);
  assert.match(readme, /plugin install plamo@plamo-plugin-cc/, 'README has the install line');
});

test('the API guide is self-contained and its internal links resolve', () => {
  const guide = skills.find((skill) => skill.directory === 'api-guide');
  // Reading another file from the plugin directory needs a permission the user
  // may not have granted, so the guide must not depend on companion files.
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, 'skills', 'api-guide')), ['SKILL.md']);
  assert.equal(guide.frontmatter['allowed-tools'], undefined, 'a skill Claude starts on its own must not grant itself tools');

  const anchors = new Set(
    [...guide.body.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
      heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/ /g, '-'),
    ),
  );
  const links = [...guide.body.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 10);
  for (const link of links) assert.ok(anchors.has(link), `#${link} points at a heading`);
  assert.doesNotMatch(guide.body, /\]\((?!#|https:\/\/)/, 'no relative file links');
});

test('local secrets are ignored by git', () => {
  const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('.local/'));
  assert.ok(ignore.includes('.env'));
});
