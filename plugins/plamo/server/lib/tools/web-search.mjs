// web_search: an answer grounded in a web search, with its sources.

import { MAX_OUTPUT_TOKENS } from '../config.mjs';
import { ToolError } from '../errors.mjs';
import { annotateCitations, describeTokens, metaLine, renderSources } from '../format.mjs';
import { PlamoApiError } from '../plamo-client.mjs';

export function createWebSearchTool({ client, config }) {
  return {
    name: 'web_search',
    title: 'PLaMo web search',
    description:
      'Answer a question with PLaMo web search: PLaMo searches the web, reads the results and answers with numbered sources. ' +
      'Use it when the user asks PLaMo to look something up, or wants current information with citations (it is strong on Japanese-language sources). ' +
      'Every call is billed per search on top of the tokens, and search queries derived from the question go to an external search service. ' +
      'Call it only when the user asked for a PLaMo web search, and keep secrets and personal data out of the query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description:
            'The question to answer, in natural language, with the constraints that matter (period, region, the form of the answer). PLaMo answers in the language of the query.',
        },
        context_size: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'How much of the search results PLaMo reads before answering: "low" is the fastest and cheapest, "high" the most thorough. Default "medium".',
        },
        allowed_domains: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 100,
          description: 'Restrict the sources to these domains, for example ["go.jp", "preferred.jp"].',
        },
        location: {
          type: 'object',
          properties: {
            country: { type: 'string', description: 'Two-letter country code, e.g. "JP".' },
            region: { type: 'string' },
            city: { type: 'string' },
            timezone: { type: 'string', description: 'IANA time zone, e.g. "Asia/Tokyo".' },
          },
          additionalProperties: false,
          description: 'Approximate location of the user, to localise the results. Every field is optional.',
        },
        reasoning: { type: 'boolean', description: 'Let PLaMo reason before answering. Slower; for questions that need the results to be weighed carefully. Default false.' },
        max_tokens: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_OUTPUT_TOKENS,
          description: `Upper bound for the answer in tokens. Default: the maximum (${MAX_OUTPUT_TOKENS}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    // Not marked read-only or idempotent although it changes nothing here: every call is billed, so a client must not repeat one on its own.
    annotations: { title: 'PLaMo web search', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

    async handler(args, { signal, progress }) {
      const location = args.location && Object.keys(args.location).length > 0 ? args.location : null;
      progress('PLaMo is searching the web…', { force: true });
      let result;
      try {
        // Sampling parameters such as temperature are rejected together with web_search_options, so none are sent.
        result = await client.chatCompletion(
          {
            model: config.model,
            messages: [{ role: 'user', content: args.query }],
            web_search_options: {
              search_context_size: args.context_size ?? 'medium',
              ...(location ? { user_location: { type: 'approximate', approximate: location } } : {}),
              ...(args.allowed_domains ? { filters: { allowed_domains: args.allowed_domains } } : {}),
            },
            ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
            ...(args.reasoning ? { reasoning_effort: 'medium' } : {}),
          },
          { signal, onText: (chars) => progress(`PLaMo is writing the answer… ${chars} characters so far`), onlyRetryUnprocessed: true },
        );
      } catch (error) {
        if (error instanceof PlamoApiError && error.retryable && !error.unprocessed) {
          error.hint = [error.hint, 'The search was not repeated automatically, because searches that were already made are billed. Run it again if the answer is still needed.']
            .filter(Boolean)
            .join(' ');
        }
        throw error;
      }

      if (result.content.trim() === '') {
        throw new ToolError(
          result.finishReason === 'length'
            ? 'PLaMo returned no text: the response reached max_tokens before the answer started. Retry with a larger max_tokens or without reasoning.'
            : `PLaMo returned an empty answer (finish reason: ${result.finishReason ?? 'unknown'}).`,
        );
      }

      const { text, sources } = annotateCitations(result.content, result.annotations);
      const sourceList = renderSources(sources);
      return {
        content: [
          { type: 'text', text: sourceList ? `${text.trimEnd()}\n\n${sourceList}` : text },
          {
            type: 'text',
            text: metaLine({
              model: result.model ?? config.model,
              tokens: describeTokens(result.usage),
              'web searches': result.usage.webSearches,
              warning: result.finishReason === 'length' ? 'the answer was cut off at max_tokens' : sources.length === 0 ? 'the answer cites no sources' : null,
            }),
          },
        ],
      };
    },
  };
}
