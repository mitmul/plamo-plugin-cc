// Server-Sent Events parsing.

/**
 * Turn an SSE byte stream into events.
 *
 * Follows the parts of the SSE format an API response uses: `event:` and
 * `data:` fields, multi-line data joined with "\n", comment lines starting
 * with ":", and events separated by a blank line. CRLF and LF line endings are
 * both accepted.
 *
 * @param {AsyncIterable<Uint8Array>} body
 * @returns {AsyncGenerator<{ event: string, data: string }>}
 */
export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  function* consumeLines(final) {
    for (;;) {
      const newline = buffer.indexOf('\n');
      let line;
      if (newline !== -1) {
        line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
      } else if (final && buffer.length > 0) {
        line = buffer;
        buffer = '';
      } else {
        break;
      }
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (dataLines.length > 0) yield { event: eventName || 'message', data: dataLines.join('\n') };
        eventName = '';
        dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventName = value;
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* consumeLines(false);
  }
  buffer += decoder.decode();
  yield* consumeLines(true);
  // A stream that ends without the closing blank line still delivers its last event.
  if (dataLines.length > 0) yield { event: eventName || 'message', data: dataLines.join('\n') };
}
