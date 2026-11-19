---
name: translate
description: PLaMo でテキストやファイルを翻訳します。長い Markdown も構造を保ったまま訳せます (Translate text or files with PLaMo)
argument-hint: "<ファイルパス または テキスト> [--to <言語>] [--out <出力先>] [--translate-comments]"
disable-model-invocation: true
allowed-tools: mcp__plugin_plamo_plamo__translate
---

Translate a text or files with PLaMo.

Reply to the user in Japanese, unless they have been writing to you in another language.

The user's request:

$ARGUMENTS

## Steps

1. Work out what to translate:
   - One or more file paths (or @-mentions): file mode.
   - Anything else: text mode, the text itself is the input.
   - If nothing is given, ask what to translate, and stop.

2. Work out the target language:
   - When the user names one (`--to en`, "英語に", "into Korean"), pass it as `target_language`.
   - Otherwise leave `target_language` out. The tool then translates Japanese into English and everything else into Japanese, so there is no need to look at the input to decide.
   - Wishes about tone, terminology, or names that must stay as they are go into `instructions`.

3. File mode. For each file call `mcp__plugin_plamo_plamo__translate` with:
   - `input_file`: the absolute path.
   - `output_file`: the path given with `--out`. Otherwise the source path with `.{lang}` before the extension, written literally: `README.md` becomes `README.{lang}.md`. The tool replaces `{lang}` with the code of the target language (`README.en.md`, `README.ja.md`).
   - Never write to the source path itself unless the user explicitly asks to translate in place.
   - If the tool reports that the output file already exists, ask before replacing it, and pass `overwrite: true` only after a yes.
   - `translate_code_comments: true` with `--translate-comments`, or when the user wants the comments inside code blocks translated too. By default fenced code blocks are taken out before the translation and come back exactly as in the original, comments included, so that code is never altered.

   The tool reads and writes the files itself and handles long documents (files up to 2 MB), so do not read the file or paste its contents.

4. Text mode. Call the tool with `text` (and `target_language` if the user named one), and show the translation exactly as returned.

5. Report:
   - File mode: where the translation was saved and its size, in one or two lines. Do not print the whole translation.
   - Pass on any warning from the tool. A warning means the translation may be incomplete in one place (for example a table row or a heading is missing), so say what it reports and suggest reviewing that part.
   - If the warning says that a line of tildes or an unclosed fence was read as code, part of the text was left untranslated. When the input is not Markdown (reStructuredText, plain text with underlined titles), translate it again with `plain_text: true` and `overwrite: true`, and say that you did. When it is Markdown, tell the user which line to fix.
   - If the tool could not save the file, it returns the translation in its result instead. Explain why saving failed, and write the translation to a path the user agrees to rather than translating again.
   - Machine translation can be wrong: for documents that will be published, recommend a quick human review.

6. When something goes wrong:
   - The file is outside the project directory: explain what the tool said, and offer to translate the text itself if the user wants that.
   - The file looks like it contains credentials: explain that it was not sent, and do not work around it by pasting its contents.
   - The API key is missing or rejected: tell the user to run `/plamo:setup`.
   - The PLaMo tools are not available: the plugin's MCP server is not connected. Suggest `/plamo:setup` and checking `/mcp`.
