// Helpers that turn API results into the text a tool returns.

import path from 'node:path';

/** A backtick fence that is longer than any run of backticks in `content`. */
function fenceFor(content) {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Render attached files as a block appended to a prompt.
 * @param {{ path: string, text: string }[]} attachments
 */
export function renderAttachments(attachments) {
  if (attachments.length === 0) return '';
  const sections = attachments.map(({ path: filePath, text }) => {
    const fence = fenceFor(text);
    const language = path.extname(filePath).slice(1).toLowerCase();
    const body = text.endsWith('\n') ? text : `${text}\n`;
    return `File: ${filePath}\n${fence}${language}\n${body}${fence}`;
  });
  return `\n\n--- Attached files (${attachments.length}) ---\n\n${sections.join('\n\n')}\n`;
}

/**
 * Deduplicate cited sources, numbered in order of first appearance.
 * @param {{ url: string, title: string }[]} annotations
 * @returns {{ number: number, url: string, title: string }[]}
 */
export function collectSources(annotations) {
  const sources = [];
  const seen = new Map();
  for (const { url, title } of annotations) {
    if (seen.has(url)) continue;
    seen.set(url, sources.length + 1);
    sources.push({ number: sources.length + 1, url, title });
  }
  return sources;
}

/**
 * Insert footnote markers such as [1] where a text cites a source.
 *
 * A search-result citation is a zero-width position at the end of a sentence;
 * those get a marker. A citation that covers a span already carries an inline
 * link in the text, so it is only listed among the sources.
 *
 * Citation indexes count Unicode code points, not UTF-16 units.
 *
 * @param {string} content
 * @param {{ url: string, startIndex: number | null, endIndex: number | null }[]} annotations
 * @param {{ number: number, url: string }[]} sources  Numbering to use, from collectSources().
 */
export function insertCitationMarkers(content, annotations, sources) {
  const numberOf = new Map(sources.map((source) => [source.url, source.number]));
  const points = Array.from(content);
  const markersAt = new Map();
  for (const { url, startIndex, endIndex } of annotations) {
    if (startIndex === null || endIndex === null || startIndex !== endIndex) continue;
    if (endIndex < 0 || endIndex > points.length || !numberOf.has(url)) continue;
    const numbers = markersAt.get(endIndex) ?? new Set();
    numbers.add(numberOf.get(url));
    markersAt.set(endIndex, numbers);
  }
  if (markersAt.size === 0) return content;

  let text = '';
  for (let index = 0; index <= points.length; index += 1) {
    const numbers = markersAt.get(index);
    if (numbers) text += [...numbers].sort((a, b) => a - b).map((number) => `[${number}]`).join('');
    if (index < points.length) text += points[index];
  }
  return text;
}

/**
 * Number the sources of one answer and mark where it cites them.
 * @param {string} content
 * @param {{ url: string, title: string, startIndex: number | null, endIndex: number | null }[]} annotations
 * @returns {{ text: string, sources: { number: number, url: string, title: string }[] }}
 */
export function annotateCitations(content, annotations) {
  const sources = collectSources(annotations);
  return { text: insertCitationMarkers(content, annotations, sources), sources };
}

/** @param {{ number: number, url: string, title: string }[]} sources */
export function renderSources(sources) {
  if (sources.length === 0) return '';
  const lines = sources.map(({ number, url, title }) => (title ? `[${number}] ${title} - ${url}` : `[${number}] ${url}`));
  return `Sources:\n${lines.join('\n')}`;
}

/**
 * One line of metadata appended to a result, e.g.
 * "[PLaMo] model: plamo-3.1-prime | tokens: 34 in / 25 out".
 * @param {Record<string, string | number | null | undefined | false>} fields
 */
export function metaLine(fields) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== false && value !== '')
    .map(([key, value]) => `${key}: ${value}`);
  return `[PLaMo] ${parts.join(' | ')}`;
}

/** @param {{ inputTokens: number | null, outputTokens: number | null, reasoningTokens: number }} usage */
export function describeTokens(usage) {
  if (usage.inputTokens === null && usage.outputTokens === null) return null;
  const reasoning = usage.reasoningTokens > 0 ? `, ${usage.reasoningTokens} of them reasoning` : '';
  return `${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out${reasoning}`;
}

/** First part of a long text, cut at a line break when possible. */
export function preview(text, maxChars = 600) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  let head = trimmed.slice(0, maxChars);
  // Not through the middle of a character that takes two code units (an emoji, a rare kanji).
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  const lineBreak = head.lastIndexOf('\n');
  return `${(lineBreak > maxChars / 2 ? head.slice(0, lineBreak) : head).trimEnd()}\n…`;
}
