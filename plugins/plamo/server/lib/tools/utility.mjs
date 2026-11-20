// count_tokens and status: small tools around the main ones.

import { ToolError } from '../errors.mjs';
import { renderAttachments } from '../format.mjs';

export function createCountTokensTool({ client, config, files }) {
  return {
    name: 'count_tokens',
    title: 'Count PLaMo tokens',
    description:
      `Count how many PLaMo tokens a text or a set of files takes, and compare it with the context window of ${config.model}. ` +
      'Use it to check whether material fits before sending it to PLaMo, or to size prompts for an application that calls the PLaMo API. ' +
      'The text is sent to the PLaMo API to be counted.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to count.' },
        files: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 50,
          description: 'Text files to count, as they would be attached to a chat call. Absolute paths, or relative to the project root; inside the project directory only.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Count PLaMo tokens', readOnlyHint: true, openWorldHint: true },

    async handler(args, { signal }) {
      const attachments = await files.readAll(args.files);
      const prompt = (args.text ?? '') + renderAttachments(attachments);
      if (prompt === '') throw new ToolError('Give `text`, `files`, or both.');

      const { count, max_model_len: contextLength } = await client.tokenize({ model: config.model, prompt }, { signal });
      const share = contextLength > 0 ? ` (${((count / contextLength) * 100).toFixed(1)}% of the ${contextLength}-token context window of ${config.model})` : '';
      const lines = [`${count} tokens${share}, for ${prompt.length} characters.`];
      if (attachments.length > 0) lines.push(`Files counted: ${attachments.map((file) => `${file.path} (${file.text.length} chars)`).join(', ')}.`);
      lines.push('A chat request adds a few tokens of formatting per message, and the answer needs room too: input tokens plus max_tokens must fit in the context window.');
      return lines.join('\n');
    },
  };
}

const SETUP_STEPS = [
  'How to set the API key:',
  '  1. Create an account at https://plamo.preferredai.jp/api and issue an API key on the Profile page of the console: https://console.platform.preferredai.jp/profile',
  '  2. Give it to the plugin in one of two ways:',
  '     - run /plugin, select "plamo" on the Installed tab, choose Configure, and paste the key into "PLaMo API key" (it is kept in the system\'s secure credential store, not in a settings file); or',
  '     - export PLAMO_API_KEY=<key> in the shell that starts Claude Code.',
  '  3. Run /reload-plugins or restart Claude Code, then run /plamo:setup again.',
];

export function createStatusTool({ client, config }) {
  return {
    name: 'status',
    title: 'PLaMo plugin status',
    description:
      'Check that the PLaMo plugin is ready: whether an API key is configured (never the key itself), which model and endpoint are used, and whether the PLaMo API answers. ' +
      'Use it for /plamo:setup and whenever another PLaMo tool fails with an authentication or connection error. It costs nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'PLaMo plugin status', readOnlyHint: true, openWorldHint: true },

    async handler(_args, { signal }) {
      const keySource = { 'plugin-option': 'plugin option "PLaMo API key"', env: 'PLAMO_API_KEY environment variable' }[config.apiKeySource];
      const keyState = !keySource ? 'NOT CONFIGURED' : config.apiKeyProblem ? `MALFORMED (${keySource})` : `configured (${keySource})`;
      const lines = [
        `PLaMo plugin ${config.version} (Node.js ${process.versions.node})`,
        `- API endpoint: ${config.baseUrl}`,
        `- API key: ${keyState}`,
        `- Model: ${config.model} (Deep Research: ${config.deepResearchModel})`,
        `- Project directory (files can be read and written only inside it): ${config.projectDir}`,
      ];

      if (!client.hasApiKey) {
        const reason = config.apiKeyProblem ?? 'The plugin cannot call PLaMo until an API key is set.';
        return { content: [{ type: 'text', text: [...lines, '', reason, ...SETUP_STEPS].join('\n') }], isError: true };
      }

      try {
        const models = await client.listModels({ signal });
        const ids = models.map((model) => model.id).filter((id) => typeof id === 'string');
        lines.push(`- Connection: OK, the API key is valid (${ids.length} models available: ${ids.join(', ')})`);
        if (!ids.includes(config.model)) {
          lines.push(`- WARNING: the configured model "${config.model}" is not in that list. Set the plugin option "Model" (or PLAMO_MODEL) to one of the models above, or clear it to use the default.`);
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
        }
        lines.push('', 'Ready. Try /plamo:ask, /plamo:search, /plamo:translate, /plamo:proofread or /plamo:research.');
        return lines.join('\n');
      } catch (error) {
        if (signal.aborted) throw error;
        const detail = typeof error?.toToolMessage === 'function' ? error.toToolMessage() : String(error?.message ?? error);
        lines.push(`- Connection: FAILED. ${detail.replace(/\n/g, '\n  ')}`);
        if (error?.status === 401) lines.push('', ...SETUP_STEPS);
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
      }
    },
  };
}
