# plamo-plugin-cc

Claude Code から [PLaMo](https://plamo.preferredai.jp/) の最新モデル **PLaMo-3.1-Prime** を手軽に使うための Claude Code プラグインです。

Claude Code で作業しながら、スラッシュコマンドひとつで PLaMo に質問したり、文書を翻訳・校正させたり、Web 検索や Deep Research を走らせたりできます。PLaMo API を使うアプリを書くときに Claude が参照する API ガイドも同梱しています。

> [!NOTE]
> これは非公式のプラグインです。PLaMo は株式会社 Preferred Networks が開発・提供する生成 AI 基盤モデルであり、本プラグインは同社が提供・サポートするものではありません。

> **In English**: an unofficial Claude Code plugin for [PLaMo](https://plamo.preferredai.jp/)-3.1-Prime, the Japanese-focused LLM by Preferred Networks. It adds slash commands to ask PLaMo a question (`/plamo:ask`), search the web with citations (`/plamo:search`), translate texts and whole files (`/plamo:translate`), proofread (`/plamo:proofread`) and run Deep Research (`/plamo:research`), plus a reference that Claude consults when writing code against the PLaMo API. Install with `/plugin marketplace add mitmul/plamo-plugin-cc` and `/plugin install plamo@plamo-plugin-cc`, then set your PLaMo API key in the plugin's options or in `PLAMO_API_KEY`. It needs Node.js 18 or later. The rest of this document is in Japanese.

## できること

| コマンド | 内容 |
|---|---|
| `/plamo:ask <質問>` | PLaMo に質問し、回答をそのまま表示します。`--reasoning` で推論モード、`--web` で Web 検索を使います |
| `/plamo:search <調べたいこと>` | PLaMo の Web 検索で調べ、出典付きの回答を表示します |
| `/plamo:translate <ファイル or テキスト>` | テキストやファイルを翻訳します。長い Markdown も構造を保ったまま分割して訳します |
| `/plamo:proofread <ファイル or 文章>` | 文章を校正し、修正案を「箇所・修正案・理由」の表で示します。反映は承認したものだけ |
| `/plamo:research <調査テーマ>` | Deep Research で Web を調査し、出典付きのレポートを作成します |
| `/plamo:setup` | API キー・モデル・API への接続を確認し、設定方法を案内します |
| `/plamo:api-guide` | PLaMo API を使うコードを書くためのリファレンス。Claude が必要に応じて自動で参照します |

コマンドを使わずに「PLaMo に聞いてみて」「この README を PLaMo で英訳して」のように頼んでも動きます。

## 必要なもの

- Claude Code（v2.1.311 で動作確認）
- Node.js 18 以上（プラグイン内の MCP サーバーの実行に使います。追加の npm パッケージは不要です）
- PLaMo API の API キー（[アカウント作成](https://plamo.preferredai.jp/api) 後、[コンソールの Profile ページ](https://console.platform.preferredai.jp/profile)で発行）

macOS で動作確認し、Linux では自動テストを実行しています。Windows は未検証です。

## インストール

Claude Code のセッション内で、マーケットプレイスを追加してからプラグインをインストールします。

```text
/plugin marketplace add mitmul/plamo-plugin-cc
/plugin install plamo@plamo-plugin-cc
```

シェルから行う場合は次のとおりです。

```bash
claude plugin marketplace add mitmul/plamo-plugin-cc
claude plugin install plamo@plamo-plugin-cc
```

リポジトリを手元に置いて試すだけなら、インストールせずに 1 セッションだけ読み込むこともできます。

```bash
git clone git@github.com:mitmul/plamo-plugin-cc.git
claude --plugin-dir ./plamo-plugin-cc/plugins/plamo
```

## API キーの設定

次のどちらかで設定します。両方ある場合はプラグインのオプションが優先されます。

1. **プラグインのオプション（おすすめ）**: `/plugin` でインストールすると入力ダイアログが開くので、**PLaMo API key** に貼り付けます。あとから設定する場合は `/plugin` の **Installed** タブで **plamo** を選び、**Configure** を選びます。キーは設定ファイルではなく、OS の資格情報ストア（macOS ではキーチェーン）に保存されます。
2. **環境変数**: Claude Code を起動するシェルで `export PLAMO_API_KEY=...` を設定します。

設定したら `/reload-plugins`（または再起動）のあと、`/plamo:setup` で確認できます。API キーの有無（キーそのものは表示しません）、使用するモデル、PLaMo API への接続結果が表示されます。

## 使い方

### 質問する: `/plamo:ask`

```text
/plamo:ask 「情けは人の為ならず」の本来の意味を教えて
/plamo:ask --reasoning この設計方針の弱点を3つ挙げて @docs/design.md
/plamo:ask --web 今年のノーベル物理学賞の受賞理由は？
```

- PLaMo の回答は書き換えずにそのまま表示されます。Claude が気づいた点があれば、区別できる形で補足します。
- PLaMo はこの会話やワークスペースを見られません。「このエラー」のような指示語を使った場合は、Claude が必要な文脈を質問文に含めます。ファイルを指定すれば、その内容が添付されます。
- 続けて質問すると、同じ会話の続きとして PLaMo に渡されます（会話履歴は MCP サーバーのメモリ上にだけ保持され、セッションをまたぎません）。

### Web 検索で調べる: `/plamo:search`

```text
/plamo:search 2026年の祝日の一覧
/plamo:search --site go.jp 最低賃金の全国加重平均の推移
/plamo:search --high 生成 AI の著作権に関する国内の議論の現状
```

回答には `[1]` のような出典番号が入り、末尾に出典の一覧が付きます。`--high` / `--low` は検索結果をどれだけ読み込むか、`--site` は出典にするドメインの指定です。

### 翻訳する: `/plamo:translate`

```text
/plamo:translate README.md
/plamo:translate docs/guide.md --to ko --out docs/guide.ko.md
/plamo:translate "The quick brown fox jumps over the lazy dog."
/plamo:translate docs/tutorial.md --translate-comments
```

- 言語を指定しなければ、日本語は英語に、それ以外は日本語に翻訳します。
- ファイルは既定で `README.en.md` のように、言語コードを付けた別名で保存します。元のファイルは書き換えず、既存のファイルを無断で上書きすることもありません。
- 見出し・リスト・表・リンクなどの Markdown 構造を保ちます。長い文書は見出しや段落の切れ目で 2,000 文字ほどの単位に分割して並行に翻訳し、元の順序どおりにつなぎ合わせます。PLaMo の 1 回あたりの出力上限（20,480 トークン）を超える文書も扱えます（1 ファイル 2 MB まで）。
- `` ``` `` や `~~~` で囲んだコードブロックは翻訳の対象から外し、翻訳後に原文をそのまま差し戻します。コードは 1 文字も変わりません（引用 `>` の中のコードブロックは対象外で、変更しないよう PLaMo に指示するだけです）。データ URI のように空白のない 200 文字以上の文字列も、PLaMo に送らずそのまま残します。
- コードブロック内のコメントも訳したいときは `--translate-comments` を付けます。この場合はコードブロックも PLaMo に送り、行数が変わっていないことだけを確認します（変わっていれば原文に戻します）。コードの中身が変わっていないことまでは保証しません。
- 訳文の見出し・表の行・リスト項目・リンク・インラインコード・引用・段落の数と、長い URL を原文と照合します。合わない箇所は、何が欠けたかを PLaMo に伝えて訳し直し、それでも合わなければさらに小さく分けて訳し直します。最後まで合わなかった箇所は警告として報告します。訳し直しに使うリクエスト数には上限があるので、PLaMo が同じ誤りを繰り返しても料金が膨らみ続けることはありません。
- 照合するのは構造だけで、訳文の内容までは検証しません。また、見出しを訳すとアンカーが変わるため、ページ内リンク（`#...`）は訳文に合わせて直す必要があります。公開する文書は人の目で確認してください。
- Markdown と同じく、閉じられていない `` ``` `` の後ろは最後までコードとして扱い、その旨を警告します。reStructuredText（`.rst`）、AsciiDoc、Org、TeX、Textile のファイルでは、`~~~` などの行をコードの区切りとして扱いません。それ以外の Markdown でないテキストで同じ扱いにしたいときは、「プレーンテキストとして翻訳して」と伝えてください（ツールの `plain_text` 引数）。
- ファイルの読み書きは MCP サーバーが直接行うので、文書の中身が Claude の会話を経由しません。長い文書でも Claude 側のトークンをほとんど使いません。保存に失敗した場合は、訳文を捨てずに結果として返します。

### 校正する: `/plamo:proofread`

```text
/plamo:proofread docs/release-notes.md
/plamo:proofread --style です・ます調に統一 @CONTRIBUTING.md
/plamo:proofread --rewrite 「本日はお日柄もよく、ご参加頂きましてありがとうございました。」
```

誤字脱字、助詞の誤り、冗長な言い回し、文体や表記のゆれなどを PLaMo が指摘し、「箇所・修正案・理由」の表で表示します。Claude が勝手にファイルを書き換えることはありません。どの修正を反映するか答えると、その分だけ Claude が編集します。

### 調査レポートを作る: `/plamo:research`

```text
/plamo:research 国内の生成 AI 規制の最新動向を、事業者が対応すべき点を中心に整理して
/plamo:research 大規模言語モデルの量子化手法の比較 --site arxiv.org --out reports/quantization.md
/plamo:research status
/plamo:research cancel resp_399ba628e02832c0be2f99eb
```

- Deep Research は PLaMo 側で動くバックグラウンドジョブです。通常は数分、最長で 25 分ほどかかります。結果待ちの呼び出しが 2 分を超えると Claude Code が自動的にバックグラウンドへ移すので、その後は作業を続けられます。完了すると Claude がレポートの要点を報告します。
- 待っている間、実行中の検索クエリや閲覧中のページが進捗として Claude Code に通知されます（バックグラウンドに移ったあとは `/tasks` で確認できます）。
- 結果は完了後 24 時間、PLaMo 側に保持されます。その間は何度でも無料で取得でき、`--out` で Markdown ファイルに保存できます。Claude Code を終了しても、次のセッションで `/plamo:research status` から取得できます。
- `--max-calls 20` のように検索回数の上限を下げると、短時間・低コストの簡易レポートになります。

### PLaMo API を使うコードを書く

「PLaMo API でチャットボットを作って」「この OpenAI SDK のコードを PLaMo に対応させて」のように頼むと、Claude は同梱の `/plamo:api-guide` を参照してコードを書きます。モデル ID、エンドポイント、推論モード、構造化出力、Function Calling、Web 検索、Deep Research、エラー形式、制限などを、公式ドキュメントと実 API での確認結果をもとにまとめたものです。

PLaMo-3.1-Prime は 2026 年 10 月 27 日に提供が始まった新しいモデルなので、ガイドなしでは Claude が古い知識で誤ったコード（存在しないパラメータなど）を書くことがあります。

## MCP ツール

コマンドの実体は、プラグイン内の MCP サーバー（`plugin:plamo:plamo`）が提供する次のツールです。Claude からは `mcp__plugin_plamo_plamo__chat` のような名前で見えます。

| ツール | 内容 | 主な引数 |
|---|---|---|
| `chat` | PLaMo に 1 ターン問い合わせる | `prompt`, `system`, `files`, `conversation_id`, `reasoning`, `json_schema`, `max_tokens`, `temperature`, `output_file` |
| `web_search` | Web 検索付きで回答し、出典を付ける | `query`, `context_size`, `allowed_domains`, `location`, `reasoning` |
| `translate` | テキストやファイルを翻訳する | `text` / `input_file`, `target_language`, `instructions`, `translate_code_comments`, `output_file` |
| `deep_research_start` | Deep Research ジョブを開始する | `topic`, `allowed_domains`, `blocked_domains`, `max_tool_calls` |
| `deep_research_get` | ジョブの状況やレポートを取得する | `id`, `wait`, `output_file` |
| `deep_research_cancel` | 実行中のジョブを中止する | `id` |
| `count_tokens` | テキストやファイルの PLaMo トークン数を数える | `text`, `files` |
| `status` | 設定と API への接続を確認する | なし |

スラッシュコマンド経由では、そのコマンドが使うツールだけがそのターンに限って事前承認されます。自然文で頼んだ場合は、初回に Claude Code の許可確認が出ます。確認を省きたいツールは、`settings.json` の `permissions.allow` に追加してください。

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_plamo_plamo__chat",
      "mcp__plugin_plamo_plamo__translate",
      "mcp__plugin_plamo_plamo__count_tokens",
      "mcp__plugin_plamo_plamo__status"
    ]
  }
}
```

検索回数に応じて課金される `web_search` と `deep_research_start` は、毎回確認する設定のままにしておくのがおすすめです。

## データの扱いと料金

このプラグインのツールに渡した内容（質問文、添付ファイル、翻訳・校正する文章）は PLaMo API に送信されます。利用前に、契約しているプランでの扱いを確認してください。以下は 2026 年 11 月 19 日時点の[公式ドキュメント](https://docs.plamo.preferredai.jp/ja/pricing)の要約です。

| | 保存 | 外部への送信 | 学習への利用 | 個人情報の入力 |
|---|---|---|---|---|
| API（Standard / Provider プラン） | されない | なし | されない | 可 |
| Web 検索 | ゼロデータリテンションの対象外 | 検索クエリと閲覧する URL が外部の検索サービスへ | されない | 不可 |
| Deep Research | 結果を 24 時間保存 | 検索クエリと閲覧する URL が外部の検索サービスへ | されない | 不可 |
| **Free プラン（全機能）** | **される** | 同上 | **される** | 不可 |

- Free プランでは入出力が保存され、学習に利用されます。機密情報や個人情報を含むコード・文書を送らないでください。
- 要配慮個人情報は、プランや機能を問わず入力できません。
- Web 検索と Deep Research は、トークン料金とは別に検索回数で課金されます（Standard プランで 1 検索 3 円。2027 年 1 月 31 日まではキャンペーン価格の 2 円）。目安は Web 検索 1 回答あたり 1〜3 検索、Deep Research 1 レポートあたり 15〜25 検索です。
- 各ツールは、使用したトークン数と検索回数を結果に含めて返します。
- Web 検索と Deep Research の開始は、失敗しても自動では再実行しません（レート制限のように、リクエストが処理されていないことが確実な場合を除きます）。処理されたかどうか分からないリクエストをやり直すと、二重に課金されるおそれがあるためです。
- トークン単価とプランの詳細は[料金ページ](https://plamo.preferredai.jp/api#pricing)を、利用条件は[利用規約](https://plamo.preferredai.jp/info/terms)を確認してください。

## 安全のための設計

- **API キー**: プラグインのオプション（Claude Code が OS の資格情報ストアに保存したもの）か環境変数で受け取り、PLaMo API のエンドポイントへの認証ヘッダーにだけ使います。ツールの結果やログにキーを出力することはありません。改行や空白が混じったキーは送信せず、内容を表示しないまま「形式が正しくない」と報告します。
- **読み取れるファイル**: プロジェクトディレクトリの中だけです（シンボリックリンクは解決してから判定します）。`.env`、秘密鍵、`credentials.json`、`terraform.tfstate` のように認証情報らしい名前のファイルや、`.git`・`secrets` などのディレクトリの中のファイルは送信を拒否します。判定はファイル名によるもので、中身までは調べません。
- **書き込み**: 出力先もプロジェクトディレクトリの中に限ります。既存のファイルは `overwrite` を指定しない限り上書きせず、`.git` や `.claude` などの隠しディレクトリ・隠しファイルには書き込みません。上書きするときは元のファイルのパーミッションを引き継ぎ、読み取り専用のファイルは置き換えません。
- **勝手に呼ばない**: Claude には「ユーザーが PLaMo を使うよう頼んだときだけツールを使う」よう指示しています。
- **依存パッケージなし**: MCP サーバーは Node.js の標準機能だけで動きます。インストール時に外部のパッケージを取得しません。

## 設定

プラグインのオプション（`/plugin` → Installed → plamo → Configure）:

| オプション | 内容 |
|---|---|
| PLaMo API key | API キー。空欄なら環境変数 `PLAMO_API_KEY` を使います |
| Model | 既定で使うモデル ID。空欄なら `plamo-3.1-prime` |

環境変数（Claude Code を起動するシェルで設定）:

| 変数 | 内容 | 既定値 |
|---|---|---|
| `PLAMO_API_KEY` | API キー（プラグインのオプションが空のときに使用） | なし |
| `PLAMO_MODEL` | モデル ID（プラグインのオプションが空のときに使用） | `plamo-3.1-prime` |
| `PLAMO_BASE_URL` | API のベース URL。オンプレミス環境やプロキシ経由で使う場合に指定 | `https://api.platform.preferredai.jp/v1` |
| `PLAMO_ALLOWED_DIRS` | プロジェクト以外に読み書きを許可するディレクトリ（`:` 区切り。Windows は `;`） | なし |
| `PLAMO_DEBUG` | `1` で MCP サーバーの詳細ログを標準エラーに出力（`claude --debug` のログで確認できます） | なし |
| `PLAMO_TRANSLATE_CHUNK_CHARS` | 翻訳時に文書を分割する単位（文字数）。小さいほど正確になり、リクエスト数は増えます | `2000` |
| `PLAMO_MAX_RETRIES` | レート制限・サーバーエラー・通信エラー時の再試行回数 | `2` |

## トラブルシューティング

まず `/plamo:setup` を実行してください。原因と対処が表示されます。

| 症状 | 対処 |
|---|---|
| 「API key is not configured」 | [API キーの設定](#api-キーの設定)を行い、`/reload-plugins` を実行します |
| 「HTTP 401: Unauthorized」 | キーが誤っているか無効です。コンソールで確認し、設定し直します |
| 「HTTP 429」 | レート制限（API キーごとに毎分 100 リクエスト）か、プランの利用上限です。少し待って再実行します |
| PLaMo のツールが見つからない | `/mcp` で `plugin:plamo:plamo` の状態を確認します。`node --version` が 18 以上であることも確認してください |
| 「outside the project directory」 | ファイルがプロジェクトの外にあります。そのディレクトリで Claude Code を起動するか、`PLAMO_ALLOWED_DIRS` に追加します |
| 「already exists」 | 出力先が既に存在します。別のパスを指定するか、上書きしてよい旨を伝えます |
| 「looks like it contains credentials」 | 認証情報らしいファイルは送信しません。必要な部分だけを本文として渡してください |

## 開発

```bash
npm test             # 単体テストと、偽の PLaMo API を相手にした結合テスト（依存パッケージなし）
npm run validate     # claude plugin validate --strict（マーケットプレイスとプラグイン）
PLAMO_API_KEY=... npm run test:live   # 実際の PLaMo API を呼ぶ動作確認（少額の利用料が発生します）
```

`npm run test:live` は質問・翻訳・トークン数の確認に加えて Web 検索を 1 回行います。Web 検索を省くには `PLAMO_LIVE_SKIP_WEB_SEARCH=1` を、Deep Research（小さなジョブの実行と中止）も確認するには `PLAMO_LIVE_DEEP_RESEARCH=1` を付けます。

```text
.claude-plugin/marketplace.json   マーケットプレイス定義
plugins/plamo/
  .claude-plugin/plugin.json      プラグインのマニフェスト（オプション定義を含む）
  .mcp.json                       MCP サーバーの起動設定
  server/                         MCP サーバー（Node.js、依存なし）
    index.mjs                     エントリポイント
    lib/mcp.mjs                   MCP プロトコル層（2026-07-28 と従来のハンドシェイクの両対応）
    lib/plamo-client.mjs          PLaMo API クライアント（ストリーミング、リトライ）
    lib/tools/                    各ツールの実装
  skills/                         スラッシュコマンドと API ガイド
tests/                            テスト（node --test）
scripts/live-check.mjs            実 API での動作確認スクリプト
```

MCP サーバーは MCP の最新リビジョン（2026-07-28、ステートレス）と、それ以前の `initialize` ハンドシェイクの両方に対応しています。

## ライセンス

[MIT License](LICENSE)
