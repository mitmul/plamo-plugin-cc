// Splitting documents for translation.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findFencedBlocks, restoreFencedBlocks, splitDocument, withoutFencedBlocks } from '../plugins/plamo/server/lib/chunker.mjs';

const join = (chunks) => chunks.map((chunk) => chunk.text).join('');
const blocksOf = (text) => findFencedBlocks(text).map(({ start, end }) => text.slice(start, end));

test('a short document is one chunk, and an empty one is none', () => {
  assert.deepEqual(splitDocument('# Title\n\nBody.\n'), [{ text: '# Title\n\nBody.\n', kind: 'text' }]);
  assert.deepEqual(splitDocument(''), []);
});

test('chunks are cut between blocks and prefer to start at a heading', () => {
  const paragraph = `${'word '.repeat(30).trim()}.\n\n`;
  const text = `# A\n\n${paragraph.repeat(3)}## B\n\n${paragraph.repeat(3)}## C\n\n${paragraph}`;
  const chunks = splitDocument(text, { targetChars: 600, maxChars: 1200 });

  assert.equal(join(chunks), text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.slice(1).every((chunk) => chunk.text.startsWith('## ')), 'every later chunk starts at a heading');
  assert.ok(chunks.every((chunk) => chunk.text.endsWith('\n\n') || chunk === chunks.at(-1)), 'cuts fall on blank lines');
});

test('a fenced code block is never split, even when it contains blank lines', () => {
  const code = '```python\ndef f():\n    pass\n\n\ndef g():\n    pass\n```\n';
  const text = `Intro paragraph.\n\n${code}\nOutro paragraph.\n`;
  for (const chunk of splitDocument(text, { targetChars: 30, maxChars: 500 })) {
    const fences = (chunk.text.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, `a chunk holds whole code blocks only: ${JSON.stringify(chunk.text)}`);
  }
});

test('indented and tilde fences are recognised, and a longer fence can hold a shorter one', () => {
  const text = [
    '1. Step:',
    '   ```sh',
    '   npm test',
    '   ```',
    '',
    '~~~md',
    '```',
    'not a fence of its own',
    '```',
    '~~~',
    '',
    '````',
    '```',
    'inner',
    '```',
    '````',
    '',
  ].join('\n');
  // A block starts at its fence: the indentation before it is not part of it.
  assert.deepEqual(blocksOf(text), ['```sh\n   npm test\n   ```', '~~~md\n```\nnot a fence of its own\n```\n~~~', '````\n```\ninner\n```\n````']);
});

test('a fence may open on the line of a list marker, and ends with the list item if it is never closed', () => {
  const closed = ['Steps:', '', '1. ```bash', '   npm install', '   ```', '2. run the tests.', '', 'closing paragraph.'].join('\n');
  assert.deepEqual(blocksOf(closed), ['```bash\n   npm install\n   ```']);
  assert.equal(withoutFencedBlocks(closed), 'Steps:\n\n1. \n2. run the tests.\n\nclosing paragraph.');

  for (const marker of ['- ', '* ', '+ ', '10) ', '  - ', '- 1. ']) {
    const pad = ' '.repeat(marker.length);
    assert.deepEqual(blocksOf(`${marker}~~~\n${pad}code\n${pad}~~~\nafter`), [`~~~\n${pad}code\n${pad}~~~`], JSON.stringify(marker));
  }
  // A closing fence counts even where it is not indented as the list item is: the author meant to close the block.
  assert.deepEqual(blocksOf('1. ```\n   code\n```\n2. next'), ['```\n   code\n```']);

  // No closing fence: the block belongs to the list item and cannot outlive it.
  const unclosed = ['- ```sh', '  ls -la', '', '  pwd', '', '- next item', '', 'paragraph'].join('\n');
  assert.deepEqual(findFencedBlocks(unclosed).map((block) => ({ text: unclosed.slice(block.start, block.end), closed: block.closed })), [
    { text: '```sh\n  ls -la\n\n  pwd', closed: false },
  ]);
  // The line that ends such a block may open the next one.
  assert.deepEqual(blocksOf('- ```\n  a\n- ```\n  b\n  ```\nend'), ['```\n  a', '```\n  b\n  ```']);
});

test('what looks like a fence but is not one is left to the prose', () => {
  // Inline code that happens to start a line: the info string of a backtick fence cannot hold a backtick.
  assert.deepEqual(blocksOf('```pip install foo``` を実行します。\n\n次の段落。'), []);
  assert.deepEqual(blocksOf('``` ` ```\ntext'), []);
  // A tilde fence may have backticks and tildes after it.
  assert.deepEqual(blocksOf('~~~ `js` ~~~\ncode\n~~~'), ['~~~ `js` ~~~\ncode\n~~~']);
  // Text before the fence on its line, other than a list marker.
  assert.deepEqual(blocksOf('see ```\ncode\n```'), ['```']);
  assert.deepEqual(blocksOf('1.```\ncode'), []);
});

test('without fence handling, a line of tildes is ordinary text', () => {
  const rst = ['Title', '~~~~~', '', 'First section. '.repeat(40), '', 'Another', '~~~~~~~', '', 'Second section. '.repeat(40), ''].join('\n');
  const asMarkdown = splitDocument(rst, { targetChars: 300, maxChars: 500 });
  assert.ok(asMarkdown.some((chunk) => chunk.kind === 'code'), 'read as Markdown, the text between the tilde lines is an oversized code block');
  const asText = splitDocument(rst, { targetChars: 300, maxChars: 500, fences: false });
  assert.equal(asText.map((chunk) => chunk.text).join(''), rst);
  assert.ok(asText.every((chunk) => chunk.kind === 'text'));
  assert.ok(asText.length > 2);
});

test('a long run without spaces is passed through instead of being sent for translation', () => {
  const data = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAA'.repeat(500)}`;
  const text = `Intro paragraph.\n\nHere is the chart: ![my chart](${data}) and it shows growth.\n\nOutro paragraph.\n`;
  const chunks = splitDocument(text, { targetChars: 2000, maxChars: 4000 });
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text, 'lossless');
  assert.deepEqual(chunks.filter((chunk) => chunk.kind === 'code').map((chunk) => chunk.text), [data]);
  for (const chunk of chunks.filter((piece) => piece.kind === 'text')) assert.ok(chunk.text.length < 100, 'the text pieces hold none of the data');

  // A long URL in an otherwise short line is protected the same way.
  const url = `https://example.com/search?${'q=term&filter=value&'.repeat(12)}page=2`;
  assert.ok(url.length > 200);
  const short = splitDocument(`See [the results](${url}) for details.\n`);
  assert.deepEqual(short.map((chunk) => [chunk.kind, chunk.text]), [['text', 'See [the results]('], ['code', url], ['text', ') for details.\n']]);
  // A sentence is not such a run, however long, and neither is a URL of ordinary length.
  assert.equal(splitDocument(`${'word '.repeat(100)}https://example.com/a/b?c=d\n`).length, 1);
});

test('a line that must be cut is cut at a space, and never through the middle of a character', () => {
  const emoji = '😀'.repeat(3000);
  for (const chunk of splitDocument(`text ${emoji}`, { targetChars: 1000, maxChars: 2001 })) {
    const first = chunk.text.charCodeAt(0);
    const last = chunk.text.charCodeAt(chunk.text.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no piece ends with half a character');
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'no piece starts with the other half');
  }
  const words = 'alpha beta gamma delta '.repeat(300).trim();
  const pieces = splitDocument(words, { targetChars: 500, maxChars: 1000 });
  assert.equal(pieces.map((chunk) => chunk.text).join(''), words);
  for (const piece of pieces.slice(0, -1)) assert.match(piece.text, / $/, 'cut after a space, not inside a word');
});

test('an unterminated fence runs to the end of the text', () => {
  assert.deepEqual(blocksOf('text\n\n```js\nlet a;\n'), ['```js\nlet a;\n']);
});

test('YAML front matter stays in one piece', () => {
  const text = '---\ntitle: T\n\ntags: [a]\n---\n\n# Heading\n\nBody.\n';
  const chunks = splitDocument(text, { targetChars: 10, maxChars: 200 });
  assert.equal(chunks[0].text, '---\ntitle: T\n\ntags: [a]\n---\n\n');
  assert.equal(join(chunks), text);
});

test('an oversized code block is cut into code pieces that are not sent for translation', () => {
  const code = Array.from({ length: 80 }, (_, index) => `const x${index} = ${index};`).join('\n');
  const text = `# T\n\nBefore.\n\n\`\`\`js\n${code}\n\`\`\`\n\nAfter.\n`;
  const chunks = splitDocument(text, { targetChars: 300, maxChars: 600 });

  assert.equal(join(chunks), text);
  const codeText = chunks.filter((chunk) => chunk.kind === 'code').map((chunk) => chunk.text).join('');
  assert.equal(codeText, `\`\`\`js\n${code}\n\`\`\`\n`, 'the code pieces together are exactly the code block');
  assert.ok(chunks.filter((chunk) => chunk.kind === 'text').every((chunk) => !chunk.text.includes('const x')));
  assert.ok(chunks.every((chunk) => chunk.text.length <= 600));
});

test('an oversized block of prose is cut at line ends, and a huge line at sentence ends', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `- item ${index} ${'x'.repeat(40)}\n`).join('');
  const listChunks = splitDocument(lines, { targetChars: 300, maxChars: 600 });
  assert.equal(join(listChunks), lines);
  assert.ok(listChunks.every((chunk) => chunk.text.endsWith('\n') && chunk.kind === 'text'));

  const longLine = 'これは文です。'.repeat(200);
  const lineChunks = splitDocument(longLine, { targetChars: 300, maxChars: 600 });
  assert.equal(join(lineChunks), longLine);
  assert.ok(lineChunks.every((chunk) => chunk.text.length <= 600));
  assert.ok(lineChunks.slice(0, -1).every((chunk) => chunk.text.endsWith('。')), 'cuts fall after a sentence');
});

test('CRLF line endings survive', () => {
  const text = '# T\r\n\r\nBody one.\r\n\r\n```\r\ncode\r\n```\r\n\r\nBody two.\r\n';
  const chunks = splitDocument(text, { targetChars: 20, maxChars: 100 });
  assert.equal(join(chunks), text);
  assert.deepEqual(blocksOf(text), ['```\r\ncode\r\n```\r']);
});

test('splitting is lossless and bounded for arbitrary input', () => {
  const pieces = ['# h\n', 'text line\n', '\n', '```\n', 'code\n', '~~~py\n', '~~~\n', '- item\n', '   ```sh\n', '   ```\n', '---\n', `${'x'.repeat(50)}\n`, '\n\n', 'tail without newline'];
  // A fixed seed keeps the test reproducible.
  let seed = 20261119;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let round = 0; round < 500; round += 1) {
    let text = '';
    const count = Math.floor(random() * 40);
    for (let index = 0; index < count; index += 1) text += pieces[Math.floor(random() * pieces.length)];
    const chunks = splitDocument(text, { targetChars: 60, maxChars: 120 });
    assert.equal(join(chunks), text);
    assert.ok(chunks.every((chunk) => chunk.text.length > 0 && chunk.text.length <= 120), JSON.stringify(text));
  }
});

test('restoreFencedBlocks puts the original code back, block for block', () => {
  const source = 'A\n\n```sh\necho hi  # say hi\n```\n\nB\n\n  ~~~\n  x\n  ~~~\n';
  const translated = 'あ\n\n```sh\necho hi  # 挨拶する\n```\n\nい\n\n  ~~~\n  エックス\n  ~~~\n';
  assert.deepEqual(restoreFencedBlocks(source, translated), {
    text: 'あ\n\n```sh\necho hi  # say hi\n```\n\nい\n\n  ~~~\n  x\n  ~~~\n',
    restored: 2,
  });
});

test('restoreFencedBlocks lets a translated block stand only when it is accepted', () => {
  const source = '```sh\nls  # list\n```\n\ntext\n\n```json\n{\n  "a": 1,\n  "b": 2\n}\n```\n\n```\nsame\n```\n';
  const translated = '```sh\nls  # 一覧\n```\n\nテキスト\n\n```json\n{\n  ...\n}\n```\n\n```\nsame\n```\n';
  const sameLineCount = (original, produced) => original.split('\n').length === produced.split('\n').length;

  assert.deepEqual(restoreFencedBlocks(source, translated, sameLineCount), {
    // The shell block keeps its translated comment; the shortened JSON block is replaced.
    text: '```sh\nls  # 一覧\n```\n\nテキスト\n\n```json\n{\n  "a": 1,\n  "b": 2\n}\n```\n\n```\nsame\n```\n',
    restored: 1,
  });
});

test('restoreFencedBlocks refuses when the block counts differ', () => {
  assert.equal(restoreFencedBlocks('```\na\n```\n', 'no code at all'), null);
  assert.equal(restoreFencedBlocks('plain', '```\nnew\n```'), null);
  assert.deepEqual(restoreFencedBlocks('plain', 'そのまま'), { text: 'そのまま', restored: 0 });
});

test('withoutFencedBlocks leaves only the prose', () => {
  assert.equal(withoutFencedBlocks('a\n```\ncode\n```\nb\n~~~\nmore\n~~~'), 'a\n\nb\n');
});
