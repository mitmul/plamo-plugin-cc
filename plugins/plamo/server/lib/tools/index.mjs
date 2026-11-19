// The tools this server offers, in the order clients list them.

import { createChatTool } from './chat.mjs';
import { createDeepResearchTools } from './deep-research.mjs';
import { createTranslateTool } from './translate.mjs';
import { createCountTokensTool, createStatusTool } from './utility.mjs';
import { createWebSearchTool } from './web-search.mjs';

/**
 * @param {object} dependencies
 * @param {import('../plamo-client.mjs').PlamoClient} dependencies.client
 * @param {ReturnType<typeof import('../config.mjs').loadConfig>} dependencies.config
 * @param {ReturnType<typeof import('../files.mjs').createFileAccess>} dependencies.files
 * @param {import('../state.mjs').ConversationStore} dependencies.conversations
 * @param {import('../state.mjs').ResearchJobStore} dependencies.jobs
 */
export function createTools(dependencies) {
  return [
    createChatTool(dependencies),
    createWebSearchTool(dependencies),
    createTranslateTool(dependencies),
    ...createDeepResearchTools(dependencies),
    createCountTokensTool(dependencies),
    createStatusTool(dependencies),
  ];
}
