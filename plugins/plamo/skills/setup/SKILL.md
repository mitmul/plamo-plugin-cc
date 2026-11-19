---
name: setup
description: PLaMo プラグインの設定を確認します。API キー・モデル・API への接続をチェックし、設定方法を案内します (Check the PLaMo plugin setup)
disable-model-invocation: true
allowed-tools: mcp__plugin_plamo_plamo__status, Bash(node --version)
---

Check that the PLaMo plugin is ready to use, and guide the user through whatever is missing.

Reply to the user in Japanese, unless they have been writing to you in another language.

## Steps

1. Call `mcp__plugin_plamo_plamo__status`. It reports the plugin version, whether an API key is configured (never the key itself), the model, and whether the PLaMo API answers.

2. Show the result compactly: one line per item, and a clear verdict (ready / not ready).

3. If the API key is not configured or was rejected, explain how to set it:
   1. Create an account at https://plamo.preferredai.jp/api and issue an API key on the Profile page of the console: https://console.platform.preferredai.jp/profile
   2. Give the key to the plugin in one of two ways:
      - Run `/plugin`, select **plamo** on the **Installed** tab, choose **Configure**, and paste the key into **PLaMo API key**. It is stored in the system's secure credential store (the keychain on macOS), not in a settings file.
      - Or add `export PLAMO_API_KEY=...` to the shell profile and restart Claude Code. The plugin option takes precedence when both are set.
   3. Run `/reload-plugins` (or restart Claude Code), then `/plamo:setup` again.

   Do not ask the user to paste the key into this conversation. If they do, do not repeat it and do not write it to a file; point them to the two ways above.

4. If the status tool is not available at all, the plugin's MCP server is not running:
   - Run `node --version`. The server needs Node.js 18 or later on the `PATH` of the shell that starts Claude Code.
   - Ask the user to open `/mcp` and look at `plugin:plamo:plamo` (reconnect it from there), and at the **Errors** tab of `/plugin`.
   - `claude --debug` writes the server's error output to the debug log.

5. When everything is ready, add these notes once, briefly:
   - Commands: `/plamo:ask`, `/plamo:search`, `/plamo:translate`, `/plamo:proofread`, `/plamo:research`.
   - What the tools send goes to the PLaMo API. On the Free plan, inputs and outputs are stored and used for training, so keep confidential and personal data out.
   - `/plamo:search` and `/plamo:research` are billed per search on top of the tokens, and send search queries to an external search service.
