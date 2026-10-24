# HMP plugin 0.1.0

Claude Code から HMP へ質問と最終回答を渡す小さな殻です。Node.js 22 以上、依存パッケージなし。契約の `client_version` は `0.1.0`。マーケットプレイスと plugin の manifest に version は書きません。

## インストール

本人が承認した配布用 **release ブランチ**を使います。

1. `/plugin marketplace add <repo>#release`
2. `/plugin install hmp@hmp-marketplace`
3. `/plugin` → Marketplaces → hmp-marketplace の自動更新を on
4. `/hmp:setup` → URL・端末名を設定し、本人がターミナルでトークンを登録 → 表示されるインスタンス名を確認

`<repo>` は公開後のリポジトリ URL に置き換えます。この初版はローカルのみで、push・リポジトリ作成・release 配布は行っていません。開発時は `claude --plugin-dir ./plugins/hmp` も使えますが、Hook が有効になるので合成テスト用環境に限ってください。

形式は [公式プラグイン仕様](https://code.claude.com/docs/en/plugins)、[Hook 仕様](https://code.claude.com/docs/en/hooks)、[権限仕様](https://code.claude.com/docs/en/permissions) に従います。

## 保存・送信

- UserPromptSubmit の `prompt`、Stop の `last_assistant_message` だけを `/api/client/events` に送ります。各イベントに Hook 入力の `session_id` そのままの `session` と、`prompt` / `response` の `kind` を必ず含めます。turn は prompt_id の SHA-256、prompt_id がない場合は伏せ字後の本文 hash です。client_event_id は session_id の SHA-256・turn・kind から固定生成します。伏せ字後の本文は UTF-8 で64 KiBまでです。
- ツール出力・transcript・ファイル・作業パス・project_hint は通常の Hook では読みません。明らかな鍵形式、Bearer/Basic、秘密らしいキーの値、秘密鍵を保存前に伏せます。完全な秘密検出はできず、HMP 側の全規則と合わせます。
- `~/.hmp/config.json` は `{ "instance_url": "https://hmp.example", "device": "my-mac" }`。HTTPS 必須（合成テスト用ループバック HTTP のみ例外）。URL の認証情報・query・fragment・パスは拒否します。
- macOS は keychain の service `hmp-client`・account `<device>` からだけトークンを読みます。他 OS は `HMP_CLIENT_TOKEN` だけを読み、ファイルには保存しません。専用の client scoped token（端末ごと・90日・失効可能）が必要です。
- `~/.hmp/spool/` に伏せ字後のイベントを1件1ファイルで書いてから送信します。ディレクトリ0700・ファイル0600。確認できた受領分だけ消します。送信済み hash は `sent/` に残し、再実行を重複排除します。通信中断による再送はサーバーの冪等性で重複排除します。部分拒否・曖昧な受領は保持します。
- SessionStart は古い順に最大200件を50件ずつ再送し、config を読みます。additionalContext に `HMP: get_context_packet を呼ぶときは session_id=<この会話の session_id> を渡す` を1行返し、更新がある場合は固定の更新案内を1行加えます。session_id はそのまま渡し、本文・トークンは含めません。除外・停止中は無出力で、設定・認証・通信の失敗時も有効な session_id の案内は返します。Hook は5秒、内部全体期限は4.1秒、HTTPは最大750msです。失敗時も exit 0、案内以外は無出力です。
- 版の互換期間、client token の scope・送信量制限、原文暗号化、HMP 全規則の伏せ字はサーバーの責任です。

prompt_id が無い同一セッションの同じ本文・kind は同一イベントになります。原文や時刻を使って別イベントに分けることはしません。

旧形式で session をハッシュ化して保存した spool は元の ID を復元できないため送信せず保持します。client_event_id の計算は維持しているので、送信済み記録は引き続き重複を抑止します。

## 除外・一時停止・過去ログ

作業ディレクトリまたは親に `.hmp-ignore` があると、一時保存・送信・再送・新規処理役起動を行いません。シンボリックリンクの実体側も調べます。`/hmp:pause` で期限付き停止、解除は0分。停止中は spool も作りません。期限切れ後に再開します。既存 spool は停止中も手元に残り、起動済み処理役は継続します。

`/hmp:onboard` だけが `~/.claude/projects/<project>/*.jsonl` を読みます。指定期間の user と各ターン最後の assistant のテキストだけを、件数と期間の確認・本人了承後に同じ kind 付きで送ります。tool_result、tool_use、thinking、メタ、subagent、除外・停止中のログは対象外。プレビューの伏せ字済み計画は `~/.hmp/onboard/` に保存します。通常 Hook は過去ログを読みません。`/hmp:status` は件数・最終送信・pending・版のみ表示します。

設計 §18.1 に従い、スキル本文は入口だけに保ち、抽出の手順・出力契約は HMP の claim が返す instructions に寄せます。能力と最大値はサーバーから変更できません。

## 処理役の境界

pending がある SessionStart で headless の `claude -p` を切り離して起動します。`~/.hmp/mcp.json` は setup が次の形で作り、処理役はこの1接続以外・command・headersHelper・追加属性を拒否します。client token は処理役の環境や引数に渡しません。MCP の認証は Claude Code 側で別途利用できる必要があります。

```json
{"mcpServers":{"hmp":{"type":"http","url":"https://hmp.example/mcp"}}}
```

許可する MCP は `claim_extraction`、`submit_extraction`、`submit_purpose_links`、`claim_line_job`、`submit_line_blocks` の5つに固定。`--strict-mcp-config`、`--setting-sources ''`、`disableAllHooks`、`--permission-mode dontAsk`、`--permission-prompts none` を使います。組込みツールは Read のみで、実行ごとの一時ディレクトリだけを許可し、`blockReadsOutsideWorkingDirectories` も設定します。設定や provider の環境変数を子に引き継ぎません。

部分 stream の tool header と完成 input を監視し、許可外ツール、範囲外 Read（実体パスも確認）、2回目の claim、4回目の submit でプロセスグループを即終了します。stream 監視は Claude Code の権限制御に加える安全装置です。Read 境界設定に対応する Claude Code **2.1.309 以上**を必要とし、それより古い版では処理役を起動しません。

1日24起動・1回8件・20分を殻に固定し、`config.limits.{max_runs_per_day,max_items_per_run,max_minutes}` と小さい方を使います。0は無効化、不正値は0。1件ごとに別の Claude を起動し、1回の claim と最大3回の submit を許可します。日付は UTC、起動前に回数を記録し、失敗しても返却しません。`worker.lock` を排他作成します。異常終了で残ったロックは自動奪取せず、本人が処理役の停止を確認してから解除してください。

## 設定変更と戻し方

setup・pause は **バックアップ → diff の記録 → 戻し手順の記録 → 変更・読戻し確認** の順に実行します。`~/.hmp/backups/` と `changes/` に秘密を含まない記録を残します。既存設定への復元は表示された `manage.mjs restore <ID>` を使います。新規導入で元ファイルがない場合は自動削除せず、下のアンインストール手順を使います。setup 後の接続確認はトークン登録後の verify で行います。

本人の操作で `/plugin uninstall hmp@hmp-marketplace` → 処理役の終了確認 → `~/.hmp` を削除 → HMP 側で端末トークンを失効 → 必要なら本人が `security delete-generic-password -s hmp-client -a <device>` を実行します。削除前に必要な設定記録を退避してください。

## 検証・配布前提

`npm test`（node:test）。全テストは一時 HOME・合成会話・偽 security/claude・ループバック HTTP のみで動きます。実 HMP・実会話・実 keychain・実 `~/.claude` は使いません。

ループバック待受が `EPERM` / `EACCES` で拒否された場合は、診断を出してテスト専用の IPC fetch に自動で切り替えます。`HMP_TEST_TRANSPORT=ipc npm test` でも明示できます。同じモックの要求・応答を使いますが、IPC 経由では実 TCP 通信の確認にはなりません。それ以外の待受エラーは失敗として扱います。製品コードはこの経路を参照しません。CLI 検証は `node test/validate.mjs /absolute/path/to/claude`（一時 HOME）で実行できます。

配布前に本人が GitHub の main/release 保護・本人承認必須・CODEOWNERS の承認必須を設定し、release ブランチだけを配布してください。CODEOWNERS は同梱しました。実 Claude Code での発火、MCP 認証、古いクライアント互換、P1 段A は別途確認が必要です。既存 launchd との並行比較・停止、S10 の運用課題の解消はこのリポジトリでは行いません。

## 残さない・消す

「この会話を残したくない」「記録しないで」「オフレコで」と伝えるか `/hmp:forget` を使うと、そのセッションの以降は送信も一時保存もしません。同じセッションの未送信 spool も捨てます。送信済み分は対象件数を見せて1回確認し、了承後に HMP から消します。同じ端末・同じセッションの7日以内が対象で、それ以外は本人の MCP ツール `forget_conversation` を使います。

原文・暗号文・R2 の原本添付・要点の本文・それを根拠にした線の本文・検索索引が消えます。R2 と埋め込み索引の削除失敗は HMP が再試行します。ID・時刻・source、線のつながりと墓標を指す目印、本文なしの忘却記録は残ります。バックアップと Time Travel は保持期間まで残り、抽出のため Claude に送った分と共有済みの写しは取り戻せません。

オフレコ中は `/hmp:status` と SessionStart に「このセッションはオフレコ」と表示します。`/hmp:forget --resume` で以降だけ再開します。消した分は戻りません。既に進行中だった送信は取り消せないため、送信済み分の忘却対象に含めて確認してください。
