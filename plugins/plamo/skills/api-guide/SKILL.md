---
name: api-guide
description: PLaMo API を使うコードを書くときのリファレンス。Reference for writing, debugging or reviewing code that calls the PLaMo API (plamo-3.1-prime, Preferred Networks) - model IDs, the OpenAI-compatible endpoint, request parameters, reasoning, structured output, function calling, web search, Deep Research, token counting, errors and limits. Use it whenever an app, script or agent uses PLaMo.
---

# Building with the PLaMo API

PLaMo is the Japanese-focused LLM that Preferred Networks trains from scratch. `plamo-3.1-prime` was released on 2026-10-27, so anything you remember about earlier PLaMo versions is likely out of date. Use the facts on this page, and tell the user when something is not covered here rather than guessing.

Facts marked **(verified)** were checked against the live API on 2026-11-19. The rest comes from the official documentation as of that date: https://docs.plamo.preferredai.jp/en/api (Japanese: `/ja/api`), plus `/en/deep-research`, `/en/limit` and `/en/pricing`. When behaviour and this page disagree, trust the API and the official docs.

To try a request while you work, you can use this plugin's own tools (`chat`, `web_search`, `count_tokens`, `status`) instead of writing throwaway scripts. They run on the user's API key, so use them only when the user wants that.

Contents: [Essentials](#essentials) · [Quick start](#quick-start) · [Pitfalls](#pitfalls) · [Chat Completions](#chat-completions) · [Streaming](#streaming) · [Reasoning](#reasoning) · [Structured output](#structured-output) · [Function calling](#function-calling) · [Web search](#web-search) · [Deep Research](#deep-research) · [Models and tokens](#models-and-tokens) · [Errors and retries](#errors-and-retries) · [Quotas, pricing, data handling](#quotas-pricing-and-data-handling) · [Checklist](#checklist-before-you-finish)

## Essentials

| | |
|---|---|
| Base URL | `https://api.platform.preferredai.jp/v1` (OpenAI-compatible) |
| Auth | `Authorization: Bearer $PLAMO_API_KEY`. Keys are issued at https://console.platform.preferredai.jp/profile |
| Main model | `plamo-3.1-prime`: 262,144-token context, at most 20,480 output tokens, optional reasoning |
| Deep Research | `plamo-3.1-prime-deep-research`, only on the Responses API, only as a background job |
| Other models | `plamo-3.0-prime` (retired on 2027-01-31; requests then go to 3.1), `plamo-3.0-fin-beta` (trial model for finance, 256,000-token context, 50 requests per user per 24 hours) |
| Endpoints | `POST /chat/completions`, `POST /responses`, `GET /responses/{id}`, `POST /responses/{id}/cancel`, `POST /tokenize`, `GET /models`, `GET /models/{id}` |

The old base URL `https://platform.preferredai.jp/api/completion/v1` still answers but is deprecated.

## Quick start

Any OpenAI SDK works once the base URL and the key are set. Read the key from the environment; never hard-code it.

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://api.platform.preferredai.jp/v1",
    api_key=os.environ["PLAMO_API_KEY"],
)

response = client.chat.completions.create(
    model="plamo-3.1-prime",
    messages=[
        {"role": "system", "content": "あなたは親切な旅行アドバイザーです。"},
        {"role": "user", "content": "金沢を朝から夕方まで観光するおすすめのルートを教えてください。"},
    ],
    max_tokens=1024,
)
print(response.choices[0].message.content)
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.platform.preferredai.jp/v1",
  apiKey: process.env.PLAMO_API_KEY,
});

const response = await client.chat.completions.create({
  model: "plamo-3.1-prime",
  messages: [{ role: "user", content: "金沢のおすすめ観光ルートを教えてください。" }],
  max_tokens: 1024,
});
console.log(response.choices[0].message.content);
```

```bash
curl https://api.platform.preferredai.jp/v1/chat/completions \
  -H "Authorization: Bearer ${PLAMO_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model": "plamo-3.1-prime", "messages": [{"role": "user", "content": "こんにちは"}]}'
```

The OpenAI SDKs were exercised against the API this way with `openai` 3.55 (Python) and 7.60 (Node), including the features below **(verified)**. The official docs also show LangChain: `ChatOpenAI(base_url=..., model="plamo-3.1-prime")` from `langchain-openai`.

## Pitfalls

Read these before writing code; each one causes real bugs.

1. **`max_tokens` counts against the context window.** The API rejects a request when input tokens plus `max_tokens` exceed the context length, even if the answer would have been short. `max_tokens` defaults to 20,480, so an input above roughly 241,000 tokens fails unless you lower `max_tokens`. Values above 20,480 are rejected **(verified)**.
2. **Reasoning is off by default and has two levels.** `reasoning_effort` is `"none"` (default) or `"medium"`; `"low"` and `"high"` are not accepted. Reasoning tokens count toward `max_tokens`: with a small limit the model can spend all of it reasoning and return an empty `content` with `finish_reason: "length"` **(verified)**.
3. **The reasoning text is encrypted.** `message.reasoning` holds an opaque string starting with `..._ENCRYPTED-TEXT:` **(verified)**. For a readable trace, request a summary and read `choices[i].reasoning_summary`.
4. **Errors are not in OpenAI's format.** The body is `{"detail": "..."}` or `{"message": "..."}`, so the SDK's `e.message` is only `Error code: 404` **(verified)**. See [Errors and retries](#errors-and-retries).
5. **Structured output needs a strict schema.** Only `{"type": "json_schema", ...}` is accepted, and the model follows it reliably only when every property is `required` and every object has `additionalProperties: false` **(verified)**.
6. **Web search is a request option, not a tool.** Add `web_search_options` to a chat completion. It cannot be combined with `temperature`, `tools` and several other parameters, and it is billed per search.
7. **Deep Research is asynchronous.** `POST /responses` requires `background: true` and `store: true`, returns a job at once, and the report is fetched later.
8. **Defaults differ from OpenAI's.** `temperature` defaults to 0.3 (range 0 to 2), and `n` can only be 1 or 2.
9. **Rate limit.** 100 requests per minute per API key, as documented for the Prime model family.

## Chat Completions

`POST /v1/chat/completions`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `model` | string | required | `plamo-3.1-prime` |
| `messages` | array | required | Objects with `role` (`system`, `user`, `assistant`, and `tool` for function results) and `content` (string). Optional `name`. |
| `max_tokens` | integer | 20480 | At most 20,480. Input tokens plus `max_tokens` must fit in the context window (262,144). Reasoning tokens count toward it. |
| `temperature` | float | 0.3 | 0 to 2 |
| `top_p` | float | 1.0 | 0 to 1 |
| `n` | integer | 1 | 1 or 2 |
| `frequency_penalty`, `presence_penalty` | float | 0.0 | -2 to 2 |
| `stop` | string or array | null | Stop sequences |
| `seed` | integer | null | Best effort; identical seeds can still give different results |
| `stream` | boolean | false | Server-sent events |
| `stream_options` | object | null | `{"include_usage": true}` adds a final chunk with `usage` |
| `reasoning_effort` | `"none"` or `"medium"` | `"none"` | Ignored when `reasoning.effort` is set |
| `reasoning` | object | null | `{"effort": "none" \| "medium", "summary": "auto" \| "concise" \| "detailed"}` |
| `response_format` | object | null | `{"type": "json_schema", "json_schema": {...}}` only |
| `tools` | array | null | Function definitions |
| `tool_choice` | string or object | null | `"none"`, `"auto"`, `"required"`, or `{"type": "function", "function": {"name": "..."}}` |
| `web_search_options` | object | null | See [Web search](#web-search) |
| `safety_identifier` | string | null | An opaque end-user id for abuse detection. It may be stored, so never put personal data in it. |

`logprobs` is not supported.

A real response, trimmed **(verified)**:

```json
{
  "id": "chatcmpl-KyUcpxucLnbWWxRinPRrhSDicFqKTPQg",
  "object": "chat.completion",
  "created": 1795066591,
  "model": "plamo-3.1-prime",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": { "role": "assistant", "content": "PLaMoは、Preferred Networksが開発した大規模言語モデルです。", "tool_calls": null, "annotations": null, "reasoning": null },
      "reasoning_summary": null
    }
  ],
  "usage": { "prompt_tokens": 34, "completion_tokens": 25, "total_tokens": 59, "completion_tokens_details": { "reasoning_tokens": 0 } },
  "plamo_usage_details": [
    { "model": "plamo-3.1-prime", "usage_type": "main_response", "input_tokens": 34, "output_tokens": 25, "token_consumed": 59 },
    { "model": "plamo-guardrail", "usage_type": "input_guardrail", "input_tokens": 615, "output_tokens": 1, "token_consumed": 616 }
  ]
}
```

- `finish_reason` is `stop`, `length` (hit `max_tokens`), or `tool_calls` **(verified)**.
- `message.content` is `null` when the model calls a function. `message.annotations` carries web-search citations.
- `plamo_usage_details` breaks usage down by purpose: `main_response`, `reasoning_summary`, `web_search` (where `token_consumed` is the number of searches), and `input_guardrail`.

The SDKs do not know PLaMo's extra fields, but they pass them through **(verified)**:

| What | Python (`openai`) | Node (`openai`) |
|---|---|---|
| Send `reasoning` | `extra_body={"reasoning": {...}}` | `reasoning: {...}` in the request object (cast the type in TypeScript) |
| Send `web_search_options` | `web_search_options={...}` | `web_search_options: {...}` |
| Read `reasoning_summary` | `response.choices[0].model_extra["reasoning_summary"]` | `response.choices[0].reasoning_summary` |
| Read `plamo_usage_details` | `response.model_extra["plamo_usage_details"]` | `response.plamo_usage_details` |
| Read the error text | `e.body["detail"]` or `e.body["message"]` | `e.error.detail` or `e.error.message` |

## Streaming

With `"stream": true` the response is a stream of `data: {...}` events that ends with `data: [DONE]` **(verified)**:

- The first chunk carries `delta.role` with an empty `content`; text follows in `choices[0].delta.content`.
- With `stream_options.include_usage`, the last chunk before `[DONE]` has `choices: []` and the `usage` and `plamo_usage_details` objects.
- With reasoning on, the encrypted reasoning arrives in `delta.reasoning`, and a requested summary arrives in a late chunk as `choices[0].reasoning_summary`.
- With web search, text starts only after the search, and the citations arrive as `delta.annotations` in the chunk that carries `finish_reason`.

```python
stream = client.chat.completions.create(
    model="plamo-3.1-prime",
    messages=[{"role": "user", "content": "春の俳句を一つ"}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
    if chunk.usage:
        print(f"\n[{chunk.usage.prompt_tokens} in / {chunk.usage.completion_tokens} out]")
```

Prefer streaming for long answers: a response of many thousands of tokens can take minutes, which is longer than some HTTP clients wait for response headers.

## Reasoning

One model serves both modes; reasoning is off unless requested.

```python
response = client.chat.completions.create(
    model="plamo-3.1-prime",
    messages=[{"role": "user", "content": "..."}],
    max_tokens=4000,
    extra_body={"reasoning": {"effort": "medium", "summary": "auto"}},  # or just reasoning_effort="medium"
)
answer = response.choices[0].message.content
summary = response.choices[0].model_extra.get("reasoning_summary")   # list of strings, or None
reasoning_tokens = response.usage.completion_tokens_details.reasoning_tokens
```

- Reasoning tokens are output tokens: billed as such, and counted toward `max_tokens`. A request with `max_tokens: 100` and reasoning on returned an empty answer with `finish_reason: "length"` and `reasoning_tokens: 100` **(verified)**. Leave generous room.
- `message.reasoning` (also offered as `reasoning_content`) is encrypted and cannot be displayed **(verified)**. It can be passed back unchanged in the assistant message of the next turn.
- `reasoning.summary` (`"auto"`, `"concise"`, `"detailed"`) adds a readable summary in `choices[i].reasoning_summary`. It is produced by an extra pass that is billed separately and shows up as a `reasoning_summary` entry in `plamo_usage_details` **(verified)**.

## Structured output

```python
schema = {
    "type": "object",
    "properties": {
        "people": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
                "required": ["name", "age"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["people"],
    "additionalProperties": False,
}

response = client.chat.completions.create(
    model="plamo-3.1-prime",
    messages=[{"role": "user", "content": "次の文から人名と年齢を抽出: 田中太郎さん(34)と鈴木花子さん(29)が登壇した。"}],
    response_format={"type": "json_schema", "json_schema": {"name": "people", "schema": schema, "strict": True}},
)
data = json.loads(response.choices[0].message.content)
```

- `json_schema` takes `name` (required), `schema` (required), `description`, and `strict` (default false). With `strict: true` only a subset of JSON Schema is supported.
- Make the schema explicit: every property listed in `required`, and `additionalProperties: false` on every object. This schema was followed exactly; a schema without `required` produced unrelated keys even with `strict: true` **(verified)**.
- `{"type": "json_object"}` is not offered. Always parse defensively.
- Combined with web search, the answer follows the schema and carries no citations.

## Function calling

OpenAI-style, and it works with `plamo-3.1-prime` **(verified)**.

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "指定した都市の現在の天気を取得する",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "都市名"}},
            "required": ["city"],
        },
    },
}]

messages = [{"role": "user", "content": "東京の今の天気を教えて。"}]
first = client.chat.completions.create(model="plamo-3.1-prime", messages=messages, tools=tools, tool_choice="auto")
call = first.choices[0].message.tool_calls[0]        # finish_reason == "tool_calls", content is None
arguments = json.loads(call.function.arguments)        # {"city": "東京"}

messages += [
    {"role": "assistant", "content": "", "tool_calls": [call.model_dump()]},
    {"role": "tool", "tool_call_id": call.id, "content": json.dumps({"weather": "晴れ", "temp_c": 18}, ensure_ascii=False)},
]
final = client.chat.completions.create(model="plamo-3.1-prime", messages=messages, tools=tools)
print(final.choices[0].message.content)                # 東京の現在の天気は晴れで、気温は18度です。
```

- `function.arguments` is a JSON string; validate it before use. Tool-call ids look like `chatcmpl-tool-946665a3217091e4`.
- `tools` and `tool_choice` cannot be combined with `web_search_options`.

## Web search

Add `web_search_options` to a normal chat completion: the model searches, reads the results and answers with citations. Supported model: `plamo-3.1-prime`. It is billed per search on top of the tokens, and search queries derived from the prompt go to an external search service, so use it only where the user wants it.

```python
response = client.chat.completions.create(
    model="plamo-3.1-prime",
    messages=[{"role": "user", "content": "Preferred Networks の本社所在地は？"}],
    web_search_options={
        "search_context_size": "low",
        "user_location": {"type": "approximate", "approximate": {"country": "JP", "timezone": "Asia/Tokyo"}},
    },
)
message = response.choices[0].message
print(message.content)
sources = []
for annotation in message.annotations or []:
    citation = annotation.url_citation          # .url, .title, .start_index, .end_index
    if citation.url not in sources:
        sources.append(citation.url)
searches = sum(d["token_consumed"] for d in response.model_extra["plamo_usage_details"] if d["usage_type"] == "web_search")
```

This ran as shown **(verified)**.

| `web_search_options` field | Values | Default | Notes |
|---|---|---|---|
| `search_context_size` | `"low"`, `"medium"`, `"high"` | `"medium"` | Share of the context given to search results: a quarter, a half, or all of it. Larger means more input tokens. |
| `user_location` | `{"type": "approximate", "approximate": {"country", "region", "city", "timezone"}}` | null | Every field inside `approximate` is optional |
| `filters` | `{"allowed_domains": ["example.com", ...]}` | null | 1 to 100 domains |

- Rejected together with `web_search_options` (400): `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `n`, `seed`, `stop`, `logprobs`, `tools`, `tool_choice`. The error reads `{"detail": "Model incompatible request argument supplied: temperature"}` **(verified)**. `reasoning_effort` and `reasoning` are allowed.
- Messages that contain images cannot be used with web search.
- Send `web_search_options` only on requests that need a search: each one searches. One answer usually makes 1 to 3 searches.
- `message.annotations` is a list of `{"type": "url_citation", "url_citation": {"url", "title", "start_index", "end_index"}}`. A citation of a quoted passage covers a span, and the text there carries an inline Markdown link such as `([doda.jp](https://...))`. A citation of search results in general is a zero-width position (`start_index == end_index`) at the end of a sentence; insert your own marker there if you want to show it **(verified)**.
- Indexes are character offsets into `content`. Whether a character outside the Basic Multilingual Plane (an emoji, say) counts as one or two is not documented; check with real data if exact positions matter.
- The same URL can be cited several times; deduplicate when listing sources.
- Search results are input tokens: an answer with `search_context_size: "low"` used 8,000 to 12,000 input tokens **(verified)**.

## Deep Research

`plamo-3.1-prime-deep-research` plans an investigation, searches repeatedly, opens pages and writes a cited report. It runs as a background job on the Responses API. A job takes from a few minutes to tens of minutes (it fails with `error.code: "timeout"` after about 25), and the result is kept for 24 hours after it finishes. Charges: the tokens in `usage` plus the searches in `tool_usage.web_search.num_requests`; a full report typically makes 15 to 25 searches and, in the documentation's example, uses about 180,000 input and 20,000 output tokens.

```python
import time

job = client.responses.create(
    model="plamo-3.1-prime-deep-research",
    input="日本における生成AI規制の最近の動向を調査してください",
    background=True,
    store=True,
)
print(job.id, job.status)          # resp_8a93b6bd793f71cef0bedf43 queued

while job.status in ("queued", "in_progress"):
    time.sleep(10)
    job = client.responses.retrieve(job.id)

if job.status in ("completed", "incomplete"):
    report = "\n\n".join(
        part.text
        for item in job.output if item.type == "message"
        for part in item.content if part.type == "output_text"
    )

# client.responses.cancel(job.id) stops a job; its status becomes "cancelled".
```

`create`, `retrieve`, `cancel` and this way of extracting the report work with the OpenAI Python SDK **(verified)**.

| `POST /v1/responses` parameter | Type | Notes |
|---|---|---|
| `model` | string | Required. Only `plamo-3.1-prime-deep-research`. |
| `input` | string or array of messages | Required. With an array, the last `user` message is the question and `assistant` messages after it are used as the research plan; `system` messages are ignored. |
| `background`, `store` | boolean | Both required, both must be `true` |
| `tools` | array | Only `[{"type": "web_search", "filters": {"allowed_domains": [...], "blocked_domains": [...]}}]`, to restrict sources |
| `max_tool_calls` | integer | 1 to 100, default 100. Total of searches, page opens and in-page finds. When it is reached the remaining chapters are left out. |
| `include` | array | `["web_search_call.action.sources"]` adds the result URLs to each search call |
| `reasoning` | object | Only `{"summary": "auto" \| "concise" \| "detailed"}`. Off by default; summaries are billed as tokens. |
| `metadata` | object | String keys and values |
| `stream` | boolean | `true` is not supported at creation |

Any other parameter is an error.

| Request | Result |
|---|---|
| `GET /v1/responses/{id}` | The current Response object. `status` goes `queued`, `in_progress`, then `completed`, `incomplete`, `failed` or `cancelled`. |
| `GET /v1/responses/{id}?stream=true` | Server-sent events, replayed from the first event and then live. Resume after a dropped connection with `&starting_after=<sequence_number of the last event received>`. |
| `POST /v1/responses/{id}/cancel` | Cancels the job and returns it with `status: "cancelled"`. Cancelling again is harmless **(verified)**. |

While a job is `in_progress`, the polled object has an empty `output`; progress is only visible on the event stream **(verified)**. Useful events: `response.queued`, `response.in_progress` and `response.completed` carry the whole Response object in `response`; `response.output_item.added` and `response.output_item.done` carry `item`, where a `web_search_call` item has `action` `{"type": "search", "query": ...}` or `{"type": "open_page", "url": ..., "title": ...}`; text arrives in `response.output_text.delta`. Every event has a `sequence_number`.

The finished Response, from a real job limited to 6 tool calls **(verified)**:

```json
{
  "id": "resp_399ba628e02832c0be2f99eb",
  "object": "response",
  "status": "completed",
  "model": "plamo-3.1-prime-deep-research",
  "output": [
    { "type": "reasoning", "id": "rs_...", "summary": [{ "type": "summary_text", "text": "..." }] },
    { "type": "web_search_call", "id": "ws_...", "status": "completed",
      "action": { "type": "search", "query": "...", "queries": ["..."], "sources": [{ "type": "url", "url": "https://..." }] } },
    { "type": "web_search_call", "id": "ws_...", "status": "completed",
      "action": { "type": "open_page", "url": "https://...", "title": "..." } },
    { "type": "message", "id": "msg_...", "role": "assistant", "status": "completed",
      "content": [{ "type": "output_text", "text": "# ...", "annotations": [
        { "type": "url_citation", "start_index": 297, "end_index": 297, "url": "https://...", "title": "..." }
      ] }] }
  ],
  "usage": { "input_tokens": 24282, "output_tokens": 3892, "total_tokens": 28174 },
  "tool_usage": { "web_search": { "num_requests": 4 } },
  "error": null,
  "incomplete_details": null,
  "max_tool_calls": 6
}
```

- The report is the `output_text` of the `message` items, in Markdown. Take every `message` item: items of other types can come after it.
- Here `annotations` are flat (`url`, `title`, `start_index`, `end_index` on the annotation itself), unlike Chat Completions, where they are nested under `url_citation` **(verified)**. They are zero-width positions after a sentence, and the same position can be listed more than once.
- `status: "incomplete"` means part of the research failed, or the tool-call limit was reached, and was skipped; what is missing is described in the `summary` of a `reasoning` item. `status: "failed"` carries `error.code`, for example `"timeout"`.

## Models and tokens

`GET /v1/models` lists the models a key can use; `GET /v1/models/{id}` returns one:

```json
{ "id": "plamo-3.1-prime", "object": "model", "created": 1789084800, "owned_by": "system", "max_model_len": 262144 }
```

`max_model_len` is the context window: prompt and generated tokens together. The list returned on 2026-11-19 **(verified)**: `plamo-1.0-prime`, `plamo-2.0-prime`, `plamo-2.1-prime`, `plamo-2.2-prime`, `plamo-3.0-prime`, `plamo-3.0-fin-beta`, `plamo-3.1-prime`. The documentation only describes the 3.x models; use `plamo-3.1-prime` for new work. `plamo-3.1-prime-deep-research` is not in the list and is only valid on `/v1/responses`.

`POST /v1/tokenize` counts tokens. Give `model` and either `prompt` (a string) or `messages` (counted with the chat template applied). `add_special_tokens` (default true) and, with `messages`, `add_generation_prompt` (default true) are optional.

```bash
curl https://api.platform.preferredai.jp/v1/tokenize \
  -H "Authorization: Bearer ${PLAMO_API_KEY}" -H "Content-Type: application/json" \
  -d '{"model": "plamo-3.1-prime", "prompt": "こんにちは、世界！ Hello, world!"}'
# {"count": 8, "max_model_len": 262144, "tokens": [1, 53380, 50358, 50007, 21479, 44, 1675, 33]}
```

That is a real response **(verified)**: 23 characters, 8 tokens including the leading BOS token. PLaMo has its own tokenizer, so do not estimate tokens from characters with ratios meant for other models; count them. For long inputs, count first and set `max_tokens` to what is left of the context window, at most 20,480.

## Errors and retries

Chat Completions, Tokenize and Models **(verified)**:

| Situation | Status | Body |
|---|---|---|
| No `Authorization` header | 400 | `{"message": "missing key in request header"}` |
| Invalid API key | 401 | `{"message": "Unauthorized"}` |
| Unknown model | 404 | `{"detail": "model not found"}` |
| `max_tokens` above 20,480 | 400 | `{"detail": "max_completion_tokens must be less than or equal to 20480"}` |
| A parameter that web search does not allow | 400 | `{"detail": "Model incompatible request argument supplied: temperature"}` |

Responses API (Deep Research) **(verified)**:

| Situation | Status | Body |
|---|---|---|
| Unknown or expired job id, or another tenant's job | 404 | `{"code": "not_found", "message": "Response not found", "details": []}` |
| `background` not `true` | 400 | `{"code": "invalid_request", "message": "background=true is required for deep research", "details": []}` |

So the error text is under `detail` or `message`, never under OpenAI's `error.message`. A robust reader:

```python
import openai

def plamo_error_text(e: openai.APIStatusError) -> str:
    body = e.body if isinstance(e.body, dict) else {}
    return str(body.get("detail") or body.get("message") or e)
```

Retry `429` (rate limit or quota) and `5xx` with exponential backoff and a small retry budget; do not retry other `4xx` responses, which fail the same way again. The OpenAI SDKs already retry `429` and `5xx` twice by default (`max_retries`).

## Quotas, pricing and data handling

Quotas, from https://docs.plamo.preferredai.jp/en/limit:

| Limit | Value |
|---|---|
| Requests, Prime model family | 100 per minute per API key |
| Requests, `plamo-3.0-fin-beta` | 50 per user per 24 hours, shared with PLaMo Chat |
| Spend | 1,000,000 JPY per tenant per month (can be raised on request) |
| API keys, users, projects | 10, 10 and 50 per tenant (can be raised) |

The Free plan has its own usage cap and rate limit.

Pricing changes, so confirm on https://plamo.preferredai.jp/api#pricing (Japanese) before quoting a price:

- At the launch of `plamo-3.1-prime` the Standard plan was 60 JPY per million input tokens and 250 JPY per million output tokens (press release of 2026-10-27: https://www.preferred.jp/ja/news/pr20261027). Reasoning tokens are output tokens; a reasoning summary and web-search result text are billed as tokens too.
- Web search and Deep Research add a charge per search: 3 JPY on the Standard plan (2 JPY as a campaign price through 2027-01-31).
- `plamo-3.0-fin-beta` has no token charge on any plan.

Data handling, from https://docs.plamo.preferredai.jp/en/pricing. Tell the user about this whenever personal or confidential data is involved:

| | Stored | Sent outside PLaMo | Used for training | Personal information |
|---|---|---|---|---|
| API, Standard / Provider plan | Not retained (zero data retention) | No | No | Allowed |
| Web search, Standard / Provider | Not covered by zero data retention | Search queries go to an external search service | No | Not allowed |
| Deep Research, Standard / Provider | Result stored for 24 hours | Search queries go to an external search service | No | Not allowed |
| Any feature, Free plan | Inputs and outputs are stored | Same as above | **Yes** | Not allowed |

- Inference, conversation history and Deep Research results are processed in a region in Japan. Only web-search queries, and the URLs being read, leave it; the external search engine may keep anonymised queries for a time.
- Sensitive personal information, as defined in Japan's Act on the Protection of Personal Information, must not be entered on any plan.
- Terms of use: https://plamo.preferredai.jp/info/terms (Japanese).

## Checklist before you finish

- The model ID is `plamo-3.1-prime` (or one the user chose), not an ID from memory.
- The key comes from an environment variable or a secret store, and is not logged.
- `max_tokens` is set deliberately when inputs are long or reasoning is on.
- Errors read `detail` / `message` from the body, and `429` / `5xx` are retried with backoff.
- Web search and Deep Research are only used where the user wants them: they cost extra and send search queries to an external search service.
- For personal or confidential data, the user knows how their plan handles it.
