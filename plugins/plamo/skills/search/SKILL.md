---
name: search
description: PLaMo の Web 検索で調べ、出典付きの回答を表示します (PLaMo web search with sources)
argument-hint: "[--high|--low] [--site <domain>] <調べたいこと>"
disable-model-invocation: true
allowed-tools: mcp__plugin_plamo_plamo__web_search
---

Answer the user's question with PLaMo web search and show the answer with its sources.

Reply to the user in Japanese, unless they have been writing to you in another language.

The user's request:

$ARGUMENTS

## Steps

1. If the request above is empty, ask the user what they want to look up, and stop.

2. Call `mcp__plugin_plamo_plamo__web_search`:
   - `query`: the question in the user's own words and language, without the flags. Add the constraints they mentioned (period, region, the form of the answer). PLaMo cannot see this conversation, so spell out anything the question depends on.
   - `context_size`: `"high"` with `--high` or when the user wants a thorough answer, `"low"` with `--low` or for a quick fact. Otherwise leave it out.
   - `allowed_domains`: the domains given with `--site` (repeatable or comma-separated), or named in the request ("官公庁サイトだけ" means `["go.jp"]`).
   - Do not include secrets or personal data in the query: it is passed to an external search service.

3. Show the result:
   - A heading line such as `**PLaMo の Web 検索結果**`, then the answer exactly as returned, with its `[n]` markers and the numbered source list. Do not summarise or rewrite it.
   - If the tool warns that the answer cites no sources, say so.
   - Add a short note of your own, labelled as yours, only when something needs double-checking.

4. When something goes wrong:
   - The tool says that the search was not repeated automatically: the searches made so far may already be billed. Tell the user, and search again only if they ask.
   - The API key is missing or rejected: tell the user to run `/plamo:setup`.
   - The PLaMo tools are not available: the plugin's MCP server is not connected. Suggest `/plamo:setup` and checking `/mcp`.

A web search is billed per search on top of the tokens (usually one to three searches per answer). For a long, multi-source report use `/plamo:research` instead.
