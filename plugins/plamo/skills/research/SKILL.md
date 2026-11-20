---
name: research
description: PLaMo Deep Research で Web を調査し、出典付きレポートを作成します。状況確認・中止もできます (PLaMo Deep Research)
argument-hint: "<調査テーマ> [--out <保存先>] [--site <domain>] [--max-calls <n>]  |  status [id]  |  cancel <id>"
disable-model-invocation: true
allowed-tools: mcp__plugin_plamo_plamo__deep_research_start, mcp__plugin_plamo_plamo__deep_research_get, mcp__plugin_plamo_plamo__deep_research_cancel
---

Run PLaMo Deep Research: PLaMo plans an investigation, searches the web repeatedly, reads the pages and writes a report with citations. A job runs on PLaMo's side for a few minutes, 25 at most, and its result stays available for 24 hours.

Reply to the user in Japanese, unless they have been writing to you in another language.

The user's request:

$ARGUMENTS

Decide which case applies:

- **Start** (the default): the request is a topic or a question.
- **Status or result**: the request is empty, or asks for the status or result (`status`, `result`, "状況", "結果"), optionally with a job id such as `resp_399ba628e02832c0be2f99eb`.
- **Cancel**: the request asks to cancel a job (`cancel`, "中止", "キャンセル").

## Start

1. Write the brief. Use the user's topic in their own words and language, plus the scope they gave (period, region, what the report should cover). PLaMo cannot see this conversation, so include anything the topic depends on. If the topic is too vague to research (a single word, no angle), ask one short question first.

2. Call `mcp__plugin_plamo_plamo__deep_research_start` with `topic`. Pass the options only when the user asked for them:
   - `allowed_domains` from `--site` (repeatable or comma-separated) or a request such as "政府機関のサイトだけ".
   - `blocked_domains` for sites to avoid.
   - `max_tool_calls` from `--max-calls`, or a small number such as 20 when the user wants a quick, cheap report.

3. Tell the user in one or two lines: the job id, that it usually takes a few minutes (up to about 25), and that they can keep working in the meantime.

4. Call `mcp__plugin_plamo_plamo__deep_research_get` with that `id` and `wait: true`. With `--out <path>`, also pass `output_file`. Claude Code moves this long call to the background by itself and delivers the result when the job ends.

5. When the result arrives, report:
   - A short report: show it in full, with its `[n]` markers and source list.
   - A long report: give a structured summary of the findings that keeps the `[n]` source markers, then list the sources you referred to.
   - The job id, and the number of searches and tokens from the result.
   - Unless it was already saved, offer to save the full report as Markdown: call `deep_research_get` again with `output_file` (fetching is free for 24 hours).
   - If the job ended as `incomplete`, `failed` or `cancelled`, say so plainly and pass on the reason.

## Status or result

Call `mcp__plugin_plamo_plamo__deep_research_get` with the `id` if one was given (without it the tool uses the job most recently started from this project), and `wait: false`. Report the status, or the report as described under Start, step 5.

## Cancel

Call `mcp__plugin_plamo_plamo__deep_research_cancel` with the `id`. If the user gave no id, call `deep_research_get` first to find the most recent job, and confirm that it is the one to cancel.

## Things to know

- Deep Research is billed per search (typically 15 to 25 per report) on top of about 200,000 tokens, and the search queries go to an external search service. Do not put secrets or personal data into the brief.
- If starting a job fails with a gateway or network error, do not start it again on your own. PLaMo may have started the job all the same, and a second one would be billed again. Tell the user what the tool reported and let them decide.
- The API key is missing or rejected: tell the user to run `/plamo:setup`.
- The PLaMo tools are not available: the plugin's MCP server is not connected. Suggest `/plamo:setup` and checking `/mcp`.
