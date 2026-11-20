// chat: one turn of conversation with PLaMo.

import { MAX_OUTPUT_TOKENS } from '../config.mjs';
import { ToolError } from '../errors.mjs';
import { describeTokens, metaLine, preview, renderAttachments } from '../format.mjs';

/**
 * Above this many characters the prompt may come close to the context window,
 * so the exact token count is fetched and `max_tokens` is fitted to the room
 * that is left. (The API rejects a request whose input plus `max_tokens`
 * exceeds the context length, even when the answer would have been short.)
 */
const TOKENIZE_THRESHOLD_CHARS = 120_000;
const TOKEN_MARGIN = 64;

/**
 * Pick a `max_tokens` that the request can actually use.
 * @returns {Promise<number | undefined>} undefined keeps the API default.
 */
export async function fitMaxTokens({ client, model, messages, requested, signal }) {
  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  if (chars < TOKENIZE_THRESHOLD_CHARS) return requested;

  const { count, max_model_len: contextLength } = await client.tokenize({ model, messages }, { signal });
  const room = contextLength - count - TOKEN_MARGIN;
  if (room < 256) {
    throw new ToolError(
      `The input is too long for ${model}: about ${count} tokens, and the context window is ${contextLength}. Attach fewer files or pass an excerpt.`,
    );
  }
  return Math.min(requested ?? MAX_OUTPUT_TOKENS, room);
}

function responseFormat(jsonSchema) {
  if (!jsonSchema) return undefined;
  // Accept both a bare JSON Schema and the API's own { name, schema, strict } wrapper.
  const wrapped = typeof jsonSchema.name === 'string' && jsonSchema.schema !== null && typeof jsonSchema.schema === 'object';
  return {
    type: 'json_schema',
    json_schema: wrapped ? jsonSchema : { name: 'response', schema: jsonSchema, strict: true },
  };
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function createChatTool({ client, config, files, conversations }) {
  return {
    name: 'chat',
    title: 'Ask PLaMo',
    description:
      `Ask PLaMo (${config.model}), the Japanese-focused LLM built by Preferred Networks, and return its answer. ` +
      'Use it when the user wants PLaMo to answer a question, give a second opinion, or write, rewrite, summarise or proofread text, especially Japanese text. ' +
      'PLaMo sees neither this conversation nor the workspace: put everything it needs into `prompt`, and attach text files with `files`. ' +
      'The prompt and the attached files are sent to the PLaMo API, so leave out secrets and personal data. ' +
      'For answers grounded in a web search use `web_search`; for translating documents use `translate`.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'The message for PLaMo, with all the context it needs. PLaMo answers in the language of the prompt.',
        },
        system: { type: 'string', description: 'Optional system prompt: the role, tone or output format PLaMo should follow.' },
        files: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 50,
          description:
            'Text files to attach as context. Absolute paths, or paths relative to the project root. Only files inside the project directory are accepted, and files that look like credentials are refused.',
        },
        conversation_id: {
          type: 'string',
          description: 'Continue an earlier conversation: pass the conversation_id that a previous chat call returned. Omit it to start a new one.',
        },
        reasoning: {
          type: 'boolean',
          description:
            'Let PLaMo reason before answering (reasoning_effort "medium"). Helps with hard, multi-step problems; slower and uses more output tokens. Default false.',
        },
        json_schema: {
          type: 'object',
          description:
            'Request structured output: a JSON Schema the answer must follow. List every property under `required` and set `additionalProperties: false` on each object, otherwise PLaMo may not follow the schema.',
        },
        max_tokens: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_OUTPUT_TOKENS,
          description: `Upper bound for the answer in tokens, reasoning included. Default: the maximum (${MAX_OUTPUT_TOKENS}).`,
        },
        temperature: { type: 'number', minimum: 0, maximum: 2, description: 'Sampling temperature. The API default is 0.3.' },
        output_file: {
          type: 'string',
          description:
            'Save the answer to this file instead of returning all of it; the result is then the path and a short preview. Must be inside the project directory.',
        },
        overwrite: { type: 'boolean', description: 'Allow output_file to replace an existing file. Default false.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    // "Destructive" because output_file with overwrite replaces a file.
    annotations: { title: 'Ask PLaMo', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

    async handler(args, { signal, progress }) {
      const history = args.conversation_id ? conversations.get(args.conversation_id) : [];
      if (!history) {
        throw new ToolError(
          `Unknown conversation_id "${args.conversation_id}". Conversations are kept in memory and end when the PLaMo server restarts. Omit conversation_id to start a new one, and include the earlier context in the prompt.`,
        );
      }
      // Check the destination first, so that nothing is spent on an answer that cannot be saved.
      if (args.output_file) await files.resolveWritable(args.output_file, { overwrite: args.overwrite });

      const attachments = await files.readAll(args.files);
      const system = args.system ?? history.find((message) => message.role === 'system')?.content;
      const messages = [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...history.filter((message) => message.role !== 'system'),
        { role: 'user', content: args.prompt + renderAttachments(attachments) },
      ];

      const maxTokens = await fitMaxTokens({ client, model: config.model, messages, requested: args.max_tokens, signal });
      progress('Waiting for PLaMo…', { force: true });
      const result = await client.chatCompletion(
        {
          model: config.model,
          messages,
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
          ...(args.reasoning ? { reasoning_effort: 'medium' } : {}),
          ...(args.json_schema ? { response_format: responseFormat(args.json_schema) } : {}),
        },
        { signal, onText: (chars) => progress(`PLaMo is answering… ${chars} characters so far`) },
      );

      const truncated = result.finishReason === 'length';
      if (result.content.trim() === '') {
        throw new ToolError(
          truncated
            ? `PLaMo returned no text: the response reached max_tokens (${maxTokens ?? MAX_OUTPUT_TOKENS})${args.reasoning ? ' while it was still reasoning' : ''}. Retry with a larger max_tokens${args.reasoning ? ', or with reasoning turned off' : ''}.`
            : `PLaMo returned an empty answer (finish reason: ${result.finishReason ?? 'unknown'}).`,
        );
      }

      const conversationId = conversations.save(args.conversation_id, [...messages, { role: 'assistant', content: result.content }]);
      const meta = metaLine({
        model: result.model ?? config.model,
        tokens: describeTokens(result.usage),
        files: attachments.length > 0 ? attachments.map((file) => file.path).join(', ') : null,
        conversation_id: conversationId,
        warning: truncated
          ? 'the answer was cut off at max_tokens'
          : args.json_schema && !isJson(result.content)
            ? 'the answer is not valid JSON'
            : null,
      });

      if (args.output_file) {
        let saved;
        try {
          saved = await files.writeText(args.output_file, result.content.endsWith('\n') ? result.content : `${result.content}\n`, {
            overwrite: args.overwrite,
          });
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          // The answer exists and has been paid for: hand it over rather than lose it.
          return {
            content: [
              { type: 'text', text: `${error.message}\nThe answer could not be saved, so it is returned here instead:\n\n${result.content}` },
              { type: 'text', text: meta },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: 'text', text: `Saved PLaMo's answer to ${saved.path} (${result.content.length} characters). Preview:\n\n${preview(result.content)}` },
            { type: 'text', text: meta },
          ],
        };
      }
      return { content: [{ type: 'text', text: result.content }, { type: 'text', text: meta }] };
    },
  };
}
