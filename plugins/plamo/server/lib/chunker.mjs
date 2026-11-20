// Splitting documents into pieces small enough to translate in one request.
//
// PLaMo returns at most 20,480 tokens per response, so a long document has to
// be translated piece by piece. The splitter understands just enough Markdown
// to cut at safe places: between blocks separated by a blank line, never
// inside a fenced code block, and preferably right before a heading.

/**
 * An opening code fence: "```js", "   ~~~", and also "1. ```bash" or "- ~~~",
 * because a fenced block may be the first thing in a list item.
 * Groups: what precedes the fence, the fence itself, the info string.
 */
const OPENING_FENCE = /^((?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)*[ \t]*)(`{3,}|~{3,})([^\r\n]*)/;
const CLOSING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?\n?$/;

/**
 * A run this long without a space is data, not language: a data URI, a URL
 * with a long query, a hash. It is never sent for translation.
 */
const OPAQUE_RUN = /[A-Za-z0-9+/=_\-:?#@!$&'*,;%.~]{200,}/;

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function isBlank(line) {
  return line.trim() === '';
}

/** The width of a line's indentation, with tabs running to the next multiple of four. */
function indentWidth(line) {
  let width = 0;
  for (const character of /^[ \t]*/.exec(line)[0]) width = character === '\t' ? width + 4 - (width % 4) : width + 1;
  return width;
}

const OUTSIDE = { state: 'none', column: 0, interrupted: false };

/**
 * Returns a function that classifies consecutive lines relative to fenced
 * code blocks. For each line it gives:
 *
 *   state        'open' and 'close' for the fence lines, 'inside' for the code
 *                between them, 'none' for everything else;
 *   column       on an 'open' line, where the fence starts (after the
 *                indentation or the list marker);
 *   interrupted  true when the line ends a block that had no closing fence.
 *
 * @param {boolean} [enabled]  false for text that is not Markdown: every line is then 'none'.
 */
function fenceClassifier(enabled = true) {
  if (!enabled) return () => OUTSIDE;
  let fence = null;
  return (line) => {
    let interrupted = false;
    if (fence !== null) {
      // A closing fence uses the same character, is at least as long, and has no info string.
      const closing = CLOSING_FENCE.exec(line);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
        fence = null;
        return { state: 'close', column: 0, interrupted };
      }
      if (fence.itemIndent === null || isBlank(line) || indentWidth(line) >= fence.itemIndent) return { state: 'inside', column: 0, interrupted };
      // The block was opened on the line of a list marker, so it belongs to
      // that list item, and this line is not indented far enough to be part
      // of the item: item and block end here.
      fence = null;
      interrupted = true;
    }
    const opening = OPENING_FENCE.exec(line);
    // "```npm test``` runs the tests" is inline code: the info string of a backtick fence cannot hold a backtick.
    if (!opening || (opening[2][0] === '`' && opening[3].includes('`'))) return { state: 'none', column: 0, interrupted };
    const [, before, marks] = opening;
    fence = { char: marks[0], length: marks.length, itemIndent: /\S/.test(before) ? indentWidth(before.replace(/\S/g, ' ')) : null };
    return { state: 'open', column: before.length, interrupted };
  };
}

/**
 * Character ranges of the fenced code blocks in `text`. A range runs from the
 * opening fence (after its indentation or list marker) to the end of the
 * closing fence line. A block without a closing fence is reported with
 * `closed: false`; it runs to the end of the text, or to the end of its list
 * item if it was opened on the line of a list marker.
 * @returns {{ start: number, end: number, closed: boolean }[]}
 */
export function findFencedBlocks(text) {
  const blocks = [];
  const classify = fenceClassifier();
  let offset = 0;
  let open = null;
  for (const line of splitLines(text)) {
    const { state, column, interrupted } = classify(line);
    const lineEnd = offset + line.length - (line.endsWith('\n') ? 1 : 0);
    if (interrupted) {
      blocks.push({ start: open.start, end: open.lastCodeEnd, closed: false });
      open = null;
    }
    if (state === 'open') open = { start: offset + column, lastCodeEnd: lineEnd };
    else if (state === 'inside' && !isBlank(line)) open.lastCodeEnd = lineEnd;
    else if (state === 'close') {
      blocks.push({ start: open.start, end: lineEnd, closed: true });
      open = null;
    }
    offset += line.length;
  }
  if (open !== null) blocks.push({ start: open.start, end: text.length, closed: false });
  return blocks;
}

/** `text` with its fenced code blocks removed. */
export function withoutFencedBlocks(text) {
  let prose = '';
  let cursor = 0;
  for (const block of findFencedBlocks(text)) {
    prose += text.slice(cursor, block.start);
    cursor = block.end;
  }
  return prose + text.slice(cursor);
}

/**
 * Put the code blocks of `source` back into `translated`, block for block.
 *
 * `accept` may let a translated block stand (it is given the original block
 * and the translated one); every other block is replaced by its original.
 * Returns null when the two texts do not have the same code blocks, one for
 * one: a different number of them, or a fence left open in one text only (a
 * lost fence line shifts every boundary after it). Nothing can be matched up
 * safely then.
 *
 * @param {string} source
 * @param {string} translated
 * @param {(original: string, produced: string) => boolean} [accept]
 * @returns {{ text: string, restored: number } | null}
 */
export function restoreFencedBlocks(source, translated, accept = () => false) {
  const originals = findFencedBlocks(source);
  const produced = findFencedBlocks(translated);
  if (originals.length !== produced.length) return null;
  if (originals.some((block, index) => block.closed !== produced[index].closed)) return null;
  let text = '';
  let cursor = 0;
  let restored = 0;
  produced.forEach((block, index) => {
    const original = source.slice(originals[index].start, originals[index].end);
    const candidate = translated.slice(block.start, block.end);
    const keep = candidate === original || accept(original, candidate);
    if (!keep) restored += 1;
    text += translated.slice(cursor, block.start) + (keep ? candidate : original);
    cursor = block.end;
  });
  return { text: text + translated.slice(cursor), restored };
}

/**
 * Group lines into blocks. A block ends at a blank line outside a code fence
 * and keeps the blank lines that follow it, so joining the blocks reproduces
 * the input. YAML front matter forms a block of its own.
 */
function toBlocks(lines, fences) {
  const blocks = [];
  let index = 0;

  if (lines.length > 0 && /^---[ \t]*\r?\n?$/.test(lines[0])) {
    const end = lines.findIndex((line, position) => position > 0 && /^(---|\.\.\.)[ \t]*\r?\n?$/.test(line));
    if (end !== -1) {
      index = end + 1;
      while (index < lines.length && isBlank(lines[index])) index += 1;
      blocks.push(lines.slice(0, index));
    }
  }

  const classify = fenceClassifier(fences);
  let current = [];
  let trailingBlank = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const blankOutsideFence = classify(line).state === 'none' && isBlank(line);
    if (!blankOutsideFence && trailingBlank) {
      blocks.push(current);
      current = [];
    }
    trailingBlank = blankOutsideFence;
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** Cut a line into its opaque runs (see OPAQUE_RUN) and the text between them. */
function splitAtOpaqueRuns(line) {
  const runs = [];
  let cursor = 0;
  for (const match of line.matchAll(new RegExp(OPAQUE_RUN, 'g'))) {
    if (match.index > cursor) runs.push({ text: line.slice(cursor, match.index), opaque: false });
    runs.push({ text: match[0], opaque: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) runs.push({ text: line.slice(cursor), opaque: false });
  return runs;
}

/**
 * A single line longer than the limit (minified text) is cut at the end of a
 * sentence, else at a space, else wherever necessary, though never through
 * the middle of a character.
 */
function splitLongLine(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const parts = [];
  let rest = line;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const sentenceEnd = Math.max(window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf('！'), window.lastIndexOf('？'));
    const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
    let cut = sentenceEnd > maxChars / 2 ? sentenceEnd + 1 : space > maxChars / 2 ? space + 1 : maxChars;
    // A character outside the Basic Multilingual Plane takes two code units; keep them together.
    const before = rest.charCodeAt(cut - 1);
    if (before >= 0xd800 && before <= 0xdbff) cut = cut > 1 ? cut - 1 : cut + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * Cut a block that is too large for one request, or that holds something
 * which must not be sent at all.
 *
 * Prose is cut at line boundaries. A fenced code block that fits in one piece
 * stays whole; a larger one is cut by lines into pieces marked "code", which
 * are passed through untranslated: without both of its fences a model cannot
 * tell that such a piece is code. An opaque run in the prose becomes a "code"
 * piece of its own.
 */
function splitOversizedBlock(lines, targetChars, maxChars, fences) {
  const segments = [];
  const classify = fenceClassifier(fences);
  for (const line of lines) {
    const { state } = classify(line);
    const fenced = state !== 'none';
    const last = segments[segments.length - 1];
    if (last && last.fenced === fenced && state !== 'open') last.lines.push(line);
    else segments.push({ fenced, lines: [line] });
  }

  const pieces = [];
  let current = '';
  const flush = (kind = 'text') => {
    if (current.length > 0) pieces.push({ text: current, kind });
    current = '';
  };

  for (const segment of segments) {
    const text = segment.lines.join('');
    if (segment.fenced && text.length <= maxChars) {
      if (current.length + text.length > maxChars) flush();
      current += text;
      continue;
    }
    if (segment.fenced) flush();
    const limit = segment.fenced ? maxChars : targetChars;
    for (const line of segment.lines) {
      for (const run of segment.fenced ? [{ text: line, opaque: false }] : splitAtOpaqueRuns(line)) {
        if (run.opaque) {
          flush();
          pieces.push({ text: run.text, kind: 'code' });
          continue;
        }
        for (const part of splitLongLine(run.text, maxChars)) {
          if (current.length > 0 && current.length + part.length > limit) flush(segment.fenced ? 'code' : 'text');
          current += part;
        }
      }
    }
    if (segment.fenced) flush('code');
  }
  flush();
  return pieces;
}

/**
 * Split a document into chunks. Joining the `text` of all chunks gives back
 * the input unchanged.
 *
 * @param {string} text
 * @param {{ targetChars?: number, maxChars?: number, fences?: boolean }} [options]
 *   Chunks are filled up to `targetChars`; a single block may reach `maxChars` before it is cut.
 *   `fences: false` is for text that is not Markdown, where a line of tildes is not a code fence.
 * @returns {{ text: string, kind: 'text' | 'code' }[]}
 *   `kind` is "code" for a piece that must not be translated: part of an oversized code block, or an opaque run.
 */
export function splitDocument(text, { targetChars = 6000, maxChars = 12000, fences = true } = {}) {
  if (text.length === 0) return [];
  const chunks = [];
  let current = '';
  const flush = () => {
    if (current.length > 0) chunks.push({ text: current, kind: 'text' });
    current = '';
  };

  for (const blockLines of toBlocks(splitLines(text), fences)) {
    const block = blockLines.join('');
    if (block.length > maxChars || OPAQUE_RUN.test(block)) {
      flush();
      chunks.push(...splitOversizedBlock(blockLines, targetChars, maxChars, fences));
      continue;
    }
    const startsWithHeading = /^ {0,3}#{1,6}\s/.test(blockLines[0]);
    const wouldOverflow = current.length + block.length > targetChars;
    // Prefer to start a new chunk at a heading once the current one is reasonably full.
    if (current.length > 0 && (wouldOverflow || (startsWithHeading && current.length >= targetChars / 2))) flush();
    current += block;
  }
  flush();
  return chunks;
}
