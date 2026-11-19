---
name: ask
description: PLaMo に質問して、回答をそのまま表示します (Ask PLaMo-3.1-Prime a question)
argument-hint: "[--reasoning] [--web] <質問>"
disable-model-invocation: true
allowed-tools: mcp__plugin_plamo_plamo__chat, mcp__plugin_plamo_plamo__web_search
---

Ask PLaMo on the user's behalf and show its answer.

Reply to the user in Japanese, unless they have been writing to you in another language.

The user's request:

$ARGUMENTS

## Steps

1. If the request above is empty, ask the user what they want to ask PLaMo, and stop.

2. Build the prompt. PLaMo sees neither this conversation nor the workspace, so the prompt has to stand on its own:
   - Keep the question in the user's own words and language.
   - When it refers to something from this session ("this error", "the function above", "さっきの案"), add that material to the prompt: quote it faithfully and keep it as short as the question allows.
   - When the user names files (paths or @-mentions), pass them in `files` as absolute paths instead of pasting their contents.

3. Call the tool, with the flags removed from the text:
   - Normally `mcp__plugin_plamo_plamo__chat` with `prompt` (and `files`).
   - Add `reasoning: true` only when the request contains `--reasoning` or asks PLaMo to think it through carefully.
   - When the request contains `--web` or asks PLaMo to search the web, call `mcp__plugin_plamo_plamo__web_search` with `query` instead.
   - When this follows up on an earlier PLaMo answer in this session, pass the `conversation_id` from that result so PLaMo keeps the thread.

4. Show the result:
   - A heading line such as `**PLaMo の回答**`, then PLaMo's answer exactly as returned. Do not summarise, translate or rewrite it. Keep the numbered sources of a web search.
   - Add a short note of your own only when you notice a factual problem or something the user should double-check, and label it as yours (for example `Claude のコメント:`). Otherwise add nothing.

5. When something goes wrong:
   - The API key is missing or rejected: tell the user to run `/plamo:setup`.
   - The PLaMo tools are not available: the plugin's MCP server is not connected. Suggest `/plamo:setup` and checking `/mcp`.
