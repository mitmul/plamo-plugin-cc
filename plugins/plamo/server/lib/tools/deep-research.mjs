// deep_research_*: long-running research jobs on the Responses API.
//
// A Deep Research job runs on PLaMo's side for minutes (25 at most) and its
// result stays available for 24 hours. Starting a job, fetching its result and
// cancelling it are therefore separate tools, tied together by the job id.

import { ToolError } from '../errors.mjs';
import { collectSources, insertCitationMarkers, metaLine, preview, renderSources } from '../format.mjs';
import { PlamoApiError, normaliseAnnotations } from '../plamo-client.mjs';
import { formatDuration, sleep } from '../util.mjs';

const TERMINAL_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled']);
// No dots: the id becomes a path segment, and "." or ".." would address something else.
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertJobId(id) {
  if (!JOB_ID.test(id)) throw new ToolError(`"${id}" is not a Deep Research job id. Ids look like "resp_399ba628e02832c0be2f99eb".`);
}

function elapsedSince(response) {
  const createdAt = Number(response?.created_at);
  return Number.isFinite(createdAt) && createdAt > 0 ? formatDuration(Date.now() / 1000 - createdAt) : null;
}

/** A status line for one event of a job's event stream, or null when the event is not worth showing. */
export function describeResearchEvent(event) {
  if (event?.type === 'response.queued') return 'Queued…';
  if (event?.type === 'response.in_progress') return 'Research started…';
  if (event?.type !== 'response.output_item.added') return null;

  const item = event.item ?? {};
  if (item.type === 'message') return 'Writing the report…';
  if (item.type !== 'web_search_call') return null;
  const action = item.action ?? {};
  if (action.type === 'search') {
    const query = action.query ?? (Array.isArray(action.queries) ? action.queries.join(', ') : '');
    return query ? `Searching: ${query}` : 'Searching the web…';
  }
  if (action.type === 'open_page') return `Reading: ${action.title || action.url || 'a page'}`;
  if (typeof action.url === 'string') return `Looking through: ${action.url}`;
  return 'Using web search…';
}

/**
 * Assemble the report from a finished response: the text of every message
 * item, with citation markers and one numbered source list for the whole report.
 */
export function renderResearchReport(response) {
  const parts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim() !== '') {
        parts.push({ text: content.text, annotations: normaliseAnnotations(content.annotations) });
      }
    }
  }
  const sources = collectSources(parts.flatMap((part) => part.annotations));
  const text = parts.map((part) => insertCitationMarkers(part.text, part.annotations, sources).trim()).join('\n\n');
  return { text, sources };
}

function researchMeta(response) {
  const usage = response.usage ?? {};
  return metaLine({
    id: response.id,
    status: response.status,
    model: response.model,
    'web searches': response.tool_usage?.web_search?.num_requests ?? null,
    tokens: usage.input_tokens !== undefined ? `${usage.input_tokens} in / ${usage.output_tokens ?? '?'} out` : null,
  });
}

export function createDeepResearchTools({ client, config, files, jobs }) {
  /**
   * Follow a job until it finishes or the waiting budget runs out. The event
   * stream supplies progress messages; plain polling is the fallback whenever
   * the stream is unavailable or breaks off.
   */
  async function waitForCompletion(id, { signal, progress }) {
    const startedAt = Date.now();
    const deadline = startedAt + config.researchWaitMs;
    const elapsed = () => formatDuration((Date.now() - startedAt) / 1000);
    let lastSequence = null;

    for (;;) {
      try {
        const events = client.streamResponse(id, { startingAfter: lastSequence, signal, timeoutMs: Math.max(1000, deadline - Date.now()) });
        for await (const event of events) {
          if (Number.isInteger(event.sequence_number)) lastSequence = event.sequence_number;
          if (event.response && TERMINAL_STATUSES.has(event.response.status)) return event.response;
          const message = describeResearchEvent(event);
          if (message) progress(`Deep Research (${elapsed()}): ${message}`);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        // Fall through to polling; the stream is retried on the next round.
      }

      const response = await client.getResponse(id, { signal });
      if (TERMINAL_STATUSES.has(response.status) || Date.now() >= deadline) return response;
      progress(`Deep Research (${elapsed()}): ${response.status}`, { force: true });
      await sleep(config.researchPollMs, signal);
    }
  }

  async function fetchJob(id, signal) {
    try {
      return await client.getResponse(id, { signal });
    } catch (error) {
      if (error instanceof PlamoApiError && error.status === 404) {
        throw new ToolError(
          `No Deep Research job with the id ${id} was found. Results are deleted 24 hours after a job finishes, and a job is only visible to the account that started it.`,
        );
      }
      throw error;
    }
  }

  const start = {
    name: 'deep_research_start',
    title: 'Start PLaMo Deep Research',
    description:
      `Start a PLaMo Deep Research job (${config.deepResearchModel}): PLaMo plans an investigation, searches the web repeatedly, reads the pages and writes a report with citations. ` +
      'The job runs in the background on PLaMo\'s side and takes from a few minutes up to about 25; this tool returns the job id at once. ' +
      'Then call `deep_research_get` with that id and `wait: true` to receive the report. ' +
      'A report typically uses 15 to 25 billed searches and around 200,000 tokens, and the search queries go to an external search service: start a job only when the user asked for Deep Research.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          minLength: 1,
          description:
            'What to research, written as a full brief: the question, the scope (period, region, industry), and what the report should contain. The report is written in the language of the brief.',
        },
        allowed_domains: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 100,
          description: 'Only use sources from these domains.',
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 100,
          description: 'Never use sources from these domains.',
        },
        max_tool_calls: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Upper bound for searches, page opens and in-page finds together. Lower it for a quicker, cheaper, shallower report. Default 100.',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    annotations: { title: 'Start PLaMo Deep Research', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

    async handler(args, { signal }) {
      const filters = {
        ...(args.allowed_domains ? { allowed_domains: args.allowed_domains } : {}),
        ...(args.blocked_domains ? { blocked_domains: args.blocked_domains } : {}),
      };
      let response;
      try {
        response = await client.createResponse(
          {
            model: config.deepResearchModel,
            input: args.topic,
            background: true,
            store: true,
            ...(Object.keys(filters).length > 0 ? { tools: [{ type: 'web_search', filters }] } : {}),
            ...(args.max_tool_calls !== undefined ? { max_tool_calls: args.max_tool_calls } : {}),
          },
          { signal },
        );
      } catch (error) {
        if (error instanceof PlamoApiError && error.retryable && !error.unprocessed) {
          error.hint = [
            error.hint,
            'The request was not repeated automatically, because a second request could start, and bill, a second job. ' +
              'PLaMo may have started this one all the same; if it did, the job runs to its end, but it cannot be looked up from here because no job id came back.',
          ]
            .filter(Boolean)
            .join(' ');
        }
        throw error;
      }
      if (typeof response?.id !== 'string') throw new ToolError('The PLaMo API accepted the request but returned no job id.');
      await jobs.add({ id: response.id, topic: args.topic, createdAt: new Date().toISOString() });

      return [
        `Deep Research job started: ${response.id} (status: ${response.status ?? 'queued'}).`,
        'It usually takes a few minutes, at most about 25. The report stays available for 24 hours after the job finishes.',
        `Next: call deep_research_get with id "${response.id}" and wait: true to receive the report when it is ready.`,
      ].join('\n');
    },
  };

  const get = {
    name: 'deep_research_get',
    title: 'Get PLaMo Deep Research result',
    description:
      'Get the status of a PLaMo Deep Research job, and its report once it has finished. ' +
      'With `wait: true` the call blocks until the job ends and reports progress on the way (which searches run, which pages are read); Claude Code moves such a long call to the background by itself. ' +
      'Without `id` it uses the job most recently started from this project. Fetching a result is free and can be repeated for 24 hours, for example to save the report with `output_file`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'The job id returned by deep_research_start. Default: the most recent job started from this project.' },
        wait: { type: 'boolean', description: 'Block until the job has finished instead of returning the current status. Default false.' },
        output_file: {
          type: 'string',
          minLength: 1,
          description:
            'Save the finished report as Markdown to this file; the result is then the path and a preview instead of the full report. Must be inside the project directory.',
        },
        overwrite: { type: 'boolean', description: 'Allow output_file to replace an existing file. Default false.' },
      },
      additionalProperties: false,
    },
    // "Destructive" because output_file with overwrite replaces a file.
    annotations: { title: 'Get PLaMo Deep Research result', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },

    async handler(args, { signal, progress }) {
      let id = args.id;
      if (!id) {
        const [latest] = await jobs.recent();
        if (!latest) throw new ToolError('No Deep Research job has been started from this project yet. Start one with deep_research_start, or pass the id of a job.');
        id = latest.id;
      }
      assertJobId(id);
      if (args.output_file) await files.resolveWritable(args.output_file, { overwrite: args.overwrite });

      let response = await fetchJob(id, signal);
      if (args.wait && !TERMINAL_STATUSES.has(response.status)) response = await waitForCompletion(id, { signal, progress });
      await jobs.setStatus(id, response.status);

      const meta = researchMeta({ ...response, id });
      if (response.status === 'failed') {
        const reason = response.error?.code === 'timeout' ? 'it ran past the time limit of about 25 minutes' : (response.error?.message ?? response.error?.code ?? 'no reason was given');
        return { content: [{ type: 'text', text: `Deep Research job ${id} failed: ${reason}.` }, { type: 'text', text: meta }], isError: true };
      }
      if (response.status === 'cancelled') {
        return { content: [{ type: 'text', text: `Deep Research job ${id} was cancelled; there is no report.` }, { type: 'text', text: meta }] };
      }
      if (!TERMINAL_STATUSES.has(response.status)) {
        const running = elapsedSince(response);
        return {
          content: [
            {
              type: 'text',
              text:
                `Deep Research job ${id} is still ${response.status}${running ? ` (started ${running} ago)` : ''}. A job can take up to about 25 minutes. ` +
                'Call deep_research_get again later, or with wait: true to block until it finishes.',
            },
            { type: 'text', text: meta },
          ],
        };
      }

      const { text, sources } = renderResearchReport(response);
      if (text === '') throw new ToolError(`Deep Research job ${id} ended as ${response.status} but returned no report text.`);
      const sourceList = renderSources(sources);
      const report = sourceList ? `${text}\n\n${sourceList}` : text;
      const note =
        response.status === 'incomplete'
          ? '\n\nNote: the job ended as "incomplete": part of the research failed or the tool-call limit was reached, so some sections may be missing.'
          : '';

      if (args.output_file) {
        const saved = await files.writeText(args.output_file, `${report}\n`, { overwrite: args.overwrite });
        return {
          content: [
            { type: 'text', text: `Saved the Deep Research report to ${saved.path} (${report.length} characters, ${sources.length} sources).${note} Preview:\n\n${preview(text, 1200)}` },
            { type: 'text', text: meta },
          ],
        };
      }
      return { content: [{ type: 'text', text: `${report}${note}` }, { type: 'text', text: meta }] };
    },
  };

  const cancel = {
    name: 'deep_research_cancel',
    title: 'Cancel PLaMo Deep Research',
    description: 'Cancel a running PLaMo Deep Research job. Searches and tokens used up to that point are still billed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'The job id returned by deep_research_start.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Cancel PLaMo Deep Research', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },

    async handler(args, { signal }) {
      assertJobId(args.id);
      const before = await fetchJob(args.id, signal);
      if (TERMINAL_STATUSES.has(before.status)) {
        await jobs.setStatus(args.id, before.status);
        return `Deep Research job ${args.id} has already ended (status: ${before.status}); nothing was cancelled.`;
      }
      const response = await client.cancelResponse(args.id, { signal });
      const status = response?.status ?? 'cancelled';
      await jobs.setStatus(args.id, status);
      return `Deep Research job ${args.id}: ${status}.`;
    },
  };

  return [start, get, cancel];
}
