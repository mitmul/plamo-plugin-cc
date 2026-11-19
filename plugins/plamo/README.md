# PLaMo plugin for Claude Code

Claude Code から PLaMo-3.1-Prime（Preferred Networks の日本語に強い LLM）を使うためのプラグインです。スラッシュコマンドで PLaMo に質問したり、文書の翻訳・校正、Web 検索、Deep Research を行えます。PLaMo API を使うコードを書くときに Claude が参照する API ガイドも含みます。非公式のプラグインであり、Preferred Networks が提供・サポートするものではありません。

## インストール

```text
/plugin marketplace add mitmul/plamo-plugin-cc
/plugin install plamo@plamo-plugin-cc
```

インストール時に表示されるダイアログで **PLaMo API key** を入力するか、環境変数 `PLAMO_API_KEY` を設定してください。キーは [PLaMo API コンソール](https://console.platform.preferredai.jp/profile)で発行できます。MCP サーバーの実行に Node.js 18 以上が必要です（追加の npm パッケージは不要）。

## コマンド

| コマンド | 内容 |
|---|---|
| `/plamo:ask <質問>` | PLaMo に質問し、回答をそのまま表示（`--reasoning`, `--web`） |
| `/plamo:search <調べたいこと>` | PLaMo の Web 検索で調べ、出典付きで回答 |
| `/plamo:translate <ファイル or テキスト>` | 翻訳。長い Markdown も構造を保って分割翻訳 |
| `/plamo:proofread <ファイル or 文章>` | 校正して修正案を一覧表示。反映は承認した分だけ |
| `/plamo:research <調査テーマ>` | Deep Research で出典付きレポートを作成 |
| `/plamo:setup` | API キー・モデル・接続の確認 |
| `/plamo:api-guide` | PLaMo API を使うコードを書くためのリファレンス（Claude が自動で参照） |

## 注意

- ツールに渡した内容は PLaMo API に送信されます。Free プランでは入出力が保存され、学習に利用されます。機密情報や個人情報を送らないでください。
- Web 検索と Deep Research は検索回数に応じて課金され、検索クエリが外部の検索サービスに送られます。
- ファイルの読み書きはプロジェクトディレクトリの中に限られ、認証情報らしいファイルは送信しません。

使い方の詳細、設定、データの扱い、トラブルシューティングは[リポジトリの README](https://github.com/mitmul/plamo-plugin-cc#readme) を参照してください。
