# HMP plugin 0.2.0

Claude Code・Codex から HMP へ本人の言葉と最終回答を渡し、1ターンずつ送った端末の Sonnet で要点を作る小さな殻です。設定に `points` の契約がないインスタンスでは、0.1.x と同じ処理役を使います。Node.js 22 以上、依存パッケージなし。契約の `client_version` は `0.2.0`。マーケットプレイスと plugin の manifest に version は書きません。

## インストール

本人が承認した配布用 **release ブランチ**を使います。

1. Claude Code で `/plugin marketplace add https://github.com/Kun-132/hmp-plugin#release` → `/plugin install hmp@hmp-marketplace` → `/plugin` → Marketplaces → hmp-marketplace の自動更新を on。
2. 本人がブラウザで `<インスタンスURL>/authorize/connect` を開き、Google でログイン → 同意 → 端末名を入力し、端末専用の client トークンを発行します。トークンは1回だけ表示されます。チャットに貼らず、次のターミナルの入力欄に貼ってください。
3. `/hmp:setup` で同じインスタンス URL と発行時の端末名を設定します。表示された account で、本人が `security add-generic-password -s hmp-client -a '<account>' -w` をターミナルで実行し、入力欄へトークンを貼ります。account は `<device>@<origin のホスト名>`。例：`my-mac@hmp.example`。既存値を更新する場合だけ `-U` を加えます。
4. 処理役用に本人が `claude mcp add --transport http --scope user hmp '<インスタンスURL>/mcp'` を実行し、下記の対話 `/mcp` で **hmp** を一度認証します。サーバー名は `hmp`、URL は setup が保存した正規化済み instance_url + `/mcp`、scope は全プロジェクトで使える `user` です。
5. `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" verify` を実行し、表示されたインスタンス名と `worker.ready: true` を確認します。`/hmp:setup` もこの順で案内・確認します。

Codex CLI（0.164）の会話も送る端末だけ、上記 setup 後に次を任意で実行します。同じ端末の `claude -p --model sonnet` が要点を作るため、Claude Code の通常ログインと処理役の認証も必要です。

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" codex-hooks install
node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" codex-hooks status
node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" codex-hooks remove
```

`install` は `~/.codex/hooks.json` の UserPromptSubmit・Stop・SessionStart の既存グループ末尾に各1件だけ追加します。同じ呼び口は重ねず、他ツールの項目・空白・表記を保持します。`status` は `installed: true|false` だけを返します。バックアップを `~/.hmp/backups/`、差分・戻し手順・読み戻し結果を `~/.hmp/changes/` に記録してから変更します。表示された `manage.mjs restore <ID>` でその時点へ復元でき、`codex-hooks remove` は HMP の項目だけを外して後から加えた他ツールの設定を保持します。新規作成した設定ファイルは、他の項目がなければ外す際に削除します。

版をまたぐ呼び口は `~/.hmp/bin/codex-hook.mjs`（ディレクトリ0700・ファイル0600）です。`~/.claude/plugins/installed_plugins.json` の `hmp@hmp-marketplace` だけを参照し、`~/.claude/plugins/cache/hmp-marketplace/` 内の実体の `scripts/hook.mjs` を呼びます。symlink・外部パスは拒否し、未導入なら無出力で exit 0。`remove` 後も呼び口と変更履歴は残ります。

Codex は `node hook.mjs <Event> codex` の入口を使い、`prompt_id` の代わりに `turn_id` で対を作り、Stop ごとにターンを閉じます。自動通知・オフレコ・一時停止・`.hmp-ignore`・一時保存・送信・ターン待ち・処理役は共通です。Codex の SessionStart は server-config の更新だけを行い、再送・処理役起動・標準出力はありません。

配布先は上記の release ブランチです。開発時は `claude --plugin-dir ./plugins/hmp` も使えますが、Hook が有効になるので合成テスト用環境に限ってください。

形式は [公式プラグイン仕様](https://code.claude.com/docs/en/plugins)、[Hook 仕様](https://code.claude.com/docs/en/hooks)、[権限仕様](https://code.claude.com/docs/en/permissions) に従います。

## 保存・送信

- UserPromptSubmit は、先頭の空白を除いた本文が `<task-notification>`・`[Subagent hand-back]`・`Another Claude session sent a message`・`<side-sessions-event>`・`<ci-monitor-event>`・`[SYSTEM NOTIFICATION` で始まる自動通知を保存・送信しません。保存済みの同じ origin の `points.automated_prefixes` は追加だけに使います。そのターンの本人の言葉も空にします。
- UserPromptSubmit の `prompt`、Stop の `last_assistant_message` だけを `/api/client/events` に送ります。各イベントに Hook 入力の `session_id` そのままの `session` と、`prompt` / `response` の `kind` を必ず含めます。turn は prompt_id の SHA-256、prompt_id がない場合は伏せ字後の本文 hash です。client_event_id は session_id の SHA-256・turn・kind から固定生成します。伏せ字後の本文は UTF-8 で64 KiBまでです。
- ツール出力・transcript・ファイル・作業パス・project_hint は通常の Hook では読みません。明らかな鍵形式、Bearer/Basic、秘密らしいキーの値、秘密鍵を保存前に伏せます。完全な秘密検出はできず、HMP 側の全規則と合わせます。
- `~/.hmp/config.json` は `{ "instance_url": "https://hmp.example", "device": "my-mac" }`。HTTPS 必須（合成テスト用ループバック HTTP のみ例外）。URL の認証情報・query・fragment・パスは拒否します。
- macOS は keychain の service `hmp-client`・account `<device>@<origin のホスト名>` からトークンを読みます。setup の戻り値 `keychain.account` が登録先です。`~/.hmp/credential-origins/` に account と完全な origin（scheme・host・port）の対応だけを記録し、違う origin ではその account を読みません。同じホスト名で scheme / port が変わる場合は account が衝突するため、新しい端末名で setup してください。既存の `<device>` だけの account は、移行 setup 前の設定に記録された origin に固定し、その origin と一致する場合だけ後方互換で読みます。新規インストールで旧 account を自動採用しません。専用の client scoped token（端末ごと・90日・失効可能）が必要です。
- 他 OS は `HMP_CLIENT_TOKEN` と、そのトークンの接続先を示す `HMP_CLIENT_ORIGIN` を本人が設定します。後者が現在の正規化済み origin と一致する場合だけ使用し、トークンをファイルには保存しません。
- `~/.hmp/spool/` に伏せ字後のイベントと保存時の `instance_origin` を1件1ファイルで書いてから送信します。現在の origin と完全一致する分だけ送信し、origin が異なる分・origin のない旧形式は手元に保留します。setup 時にも既存 spool の origin を割り当て直しません。`/hmp:status` の `spool` が全件数、`spool_held` が origin 不一致・不明による保留数（内数）です。読めないファイルも origin 不明に数えます。元の origin に設定を戻すと、その origin の保留分だけ送信を再開できます。origin 不明分は自動送信しません。
- spool・送信済み記録は origin と client_event_id の組で保存します。異なる接続先で同じイベント ID があっても上書き・送信済み扱いにしません。ディレクトリ0700・ファイル0600。origin はローカルの送信先制御用で、HTTP のイベント本文には付けません。確認できた受領分だけ消し、`sent/` に時刻と、応答にある `capture_id` を記録します。通信中断による再送はサーバーの冪等性で重複排除します。部分拒否・曖昧な受領は保持します。
- SessionStart は古い順に最大200件を20件ずつ再送し、config を読みます。additionalContext に `HMP: get_context_packet を呼ぶときは session_id=<この会話の session_id> を渡す` を1行返し、更新がある場合は固定の更新案内を1行加えます。session_id はそのまま渡し、本文・トークンは含めません。除外・停止中は無出力で、設定・認証・通信の失敗時も有効な session_id の案内は返します。Hook は5秒、内部全体期限は4.1秒、HTTP の既定は750ms、原文の送信と config 取得は Hook の残り期限まで待ちます。失敗時も exit 0、案内以外は無出力です。
- 版の互換期間、client token の scope・送信量制限、原文暗号化、HMP 全規則の伏せ字はサーバーの責任です。

prompt_id が無い同一セッションの同じ本文・kind は同一イベントになります。原文や時刻を使って別イベントに分けることはしません。

旧形式で session をハッシュ化して保存した spool は元の ID を復元できないため送信せず保持します。client_event_id の計算は維持します。origin が不明の旧送信済み記録は新形式の送信抑止には使わず、必要な再送の重複はサーバーが同じ ID で排除します。

## 除外・一時停止・過去ログ

作業ディレクトリまたは親に `.hmp-ignore` があると、一時保存・送信・再送・新規処理役起動を行いません。シンボリックリンクの実体側も調べます。`/hmp:pause` で期限付き停止、解除は0分。停止中は spool も作りません。期限切れ後に再開します。既存 spool は停止中も手元に残り、起動済み処理役は継続します。

`/hmp:onboard` だけが `~/.claude/projects/<project>/*.jsonl` を読みます。指定期間の user と各ターン最後の assistant のテキストだけを、件数と期間の確認・本人了承後に同じ kind 付きで送ります。tool_result、tool_use、thinking、メタ、subagent、除外・停止中のログは対象外。プレビューの伏せ字済み計画は、その時点の origin とともに `~/.hmp/onboard/` に保存します。送信時に origin が変わっている計画や origin 不明の旧計画は拒否し、再プレビューを必要とします。通常 Hook は過去ログを読みません。`/hmp:status` は spool の全件数・origin による保留件数・最終送信、現在の origin の端末の待ち `turns.{count,oldest,last_failure}`、HMP の `pending.{extraction,lines}`、版だけを表示します。最古は ISO 時刻、最後の失敗は固定コードだけです。HMP の待ちが未確認なら pending は null です。

設計 §18.1 に従い、スキル本文は入口だけに保ち、抽出の手順・出力契約は HMP の claim が返す instructions に寄せます。能力と最大値はサーバーから変更できません。

## 処理役の境界

`points` のないインスタンスでは、pending がある SessionStart で headless の `claude -p` を切り離して起動します。`~/.hmp/mcp.json` は setup が次の形で作り、処理役はこの1接続以外・command・headers・headersHelper・追加属性を拒否します。client token は処理役の環境や引数に渡しません。HMP MCP は Claude Code が保存した OAuth 認証を使います。client scoped token の登録だけでは MCP は認証されません。

```json
{"mcpServers":{"hmp":{"type":"http","url":"https://hmp.example/mcp"}}}
```

上記インストール手順の MCP 登録例は `claude mcp add --transport http --scope user hmp 'https://hmp.example/mcp'` です。既存の hmp がある場合は `claude mcp get hmp` で名前・URL・scope を確認し、別の接続先を認証しないようにします。既存設定を自動削除・上書きしません。

初回は処理役と同じ OS ユーザー・HOME・`CLAUDE_CONFIG_DIR`（設定している場合）で、Claude Code の通常ログインを済ませ、登録後に本人がターミナルで次を起動します。処理役と同じ JSON を明示し、プロジェクトごとの同名設定にも左右されない形で認証します。

```sh
claude --strict-mcp-config --mcp-config "$HOME/.hmp/mcp.json" \
  --setting-sources '' --settings '{"disableAllHooks":true,"enabledPlugins":{}}'
```

その対話セッションの `/mcp` から **`hmp`** を選び、URL が **setup で設定した instance_url + `/mcp`** であることを確認して Authenticate を選びます。例なら `https://hmp.example/mcp` です。ブラウザで認証を完了してください。別名や末尾スラッシュ違いの既存サーバーでの認証を前提にせず、処理役と同じ JSON で認証します。トークンをコピーしたり JSON に保存したりする必要はありません。OAuth の保存・更新は Claude Code が担当します。keychain がロックされている場合や失効後は解除・再認証が必要です。

本人の認証後に `/hmp:setup` の verify を完了します。手動なら `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" verify`。client API のインスタンス名に加え、処理役の MCP 設定で `hmp` が接続済み、要点の2ツール（契約がない場合は旧抽出の3ツール）が公開済み、短いモデル応答が成功した場合だけ `worker.ready: true` を返します。線の2ツールが揃うかは `worker.lines: true|false` で返し、線のツールがないインスタンスでは抽出だけ回します。失敗時は exit 1 で認証情報・応答本文を表示しません。確認用の Claude は組込みツールなし、MCP は `ask` + `dontAsk` で呼出しを拒否し、claim/submit は行いません。最大30秒、モデル利用分が発生します。日次の処理回数は消費しません。verify はツールの公開を確認し、実データの claim/submit の成功までは保証しません。

[公式 MCP 認証仕様](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers) は headless の前に対話で認証する手順を案内しています。strict は接続先の指定を限定する設定です。[bare モード](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode) は OAuth・keychain を読まないため使用しません。手元の実 CLI で確認できた範囲と未確認事項は [認証の検証記録](docs/worker-auth-verification.md) を参照してください。

以下の Read 付き処理と起動数の上限は、`points` のない 0.1.x 互換経路だけです。許可する MCP は段階ごとに固定し、抽出は `claim_extraction`、`submit_extraction`、`submit_purpose_links` の3つ、線は `claim_line_job`、`submit_line_blocks` の2つだけです。1起動ではその段階のツールだけを許可し、線のツールがないインスタンスでは線の起動を省いて上限内で抽出だけ続けます。`--strict-mcp-config`、`--setting-sources ''`、`disableAllHooks`、`--permission-mode dontAsk`、`--permission-prompts none` を使います。組込みツールは Read のみで、実行ごとの一時ディレクトリだけを許可し、`blockReadsOutsideWorkingDirectories` も設定します。MCP の返り値が大きいと Claude Code は作業ディレクトリ外の `tool-results` に保存して Read を促し、Read 境界で止まるため、処理役では `MAX_MCP_OUTPUT_TOKENS=100000` を固定し、claim の返り値を会話内で受け取ります。`CLAUDE_CONFIG_DIR` は対話セッションと認証保存先を揃えるため引き継ぎます。provider・トークンの環境変数は引き継ぎません。通常ログインの認証保存先を使うため、環境変数だけによるモデル認証は対象外です。

部分 stream の tool header と完成 input を監視し、許可外ツール、範囲外 Read（実体パスも確認）、2回目の claim、4回目の submit でプロセスグループを即終了します。stream 監視は Claude Code の権限制御に加える安全装置です。Read 境界設定に対応する Claude Code **2.1.309 以上**を必要とし、それより古い版では処理役を起動しません。

1日24起動・1回8件・20分を殻に固定し、`config.limits.{max_runs_per_day,max_items_per_run,max_minutes}` と小さい方を使います。0は無効化、不正値は0。1件ごとに別の Claude を起動し、1回の claim と最大3回の submit を許可します。日付は UTC、起動前に回数を記録し、失敗しても返却しません。各 Claude の接続・ツール公開・成功 result を監視し、未認証・欠けたツール・異常 result・空の exit 0 では次の項目へ進みません。`worker.lock` を排他作成します。停止済み PID のロックは一意の名前へ移して所有者を確かめてから回収し、新しい所有者のロックは消しません。各ターンの前にも所有権を確認します。

## 0.2.0 のターン処理

`/api/client/config` に `points` があれば、SessionStart は設定の取得と原文の再送だけを行い、重い抽出を起動しません。`Stop` は `async: true`。最終回答を spool に置き、`background_tasks` が未指定か空配列のときだけ、ターンを `~/.hmp/turns/` に置いて処理役を切り離します。背景の仕事がある場合も最終回答の原文は送ります。

`~/.hmp/sessions/` は、origin とセッションごとに直前の最終回答・まだ閉じていない本人の言葉を順番に持ちます。Stop と入力の両方に識別子があれば一致するものを、片方になければ古い順に組みます。背景の仕事が残る Stop は回答だけを覚えます。状態の更新にはセッションごとの短いロックを使います。待ちには、存在する部分（直前の答え・本人の言葉・今回の答え）の client_event_id、伏せ字済み本文、セッション、終了時刻を持ちます。spool と同じく origin を固定し、ディレクトリ0700・ファイル0600です。接続先を変えても別 origin の状態・待ちは使いません。一時停止・`.hmp-ignore`・オフレコ中は作りません。

処理役は共通の `worker.lock` で端末に1つだけです。先に spool を送信し、送信済みの印から各部分の capture ID を引きます。足りないターンは待ちに残して次へ進みます。文は HMP の `sourceSpans` と同じ規則（`。！？!?`・改行、空白または末尾が続く `.`、900 UTF-16 単位、空白だけを除外）で分割し、部分名と全体の通し番号を付けます。

子の起動は `claude -p --model sonnet --tools "" --strict-mcp-config --setting-sources "" --settings '{"disableAllHooks":true,"enabledPlugins":{}}' --no-session-persistence --output-format json --json-schema <output_schema>`。スキル・Chrome も無効にし、固定の system prompt で境界を保ち、抽出基準としての配布 instructions と、信頼できないデータとして囲った番号付きの文だけを標準入力に渡します。ツール・MCP 接続は与えません。子の環境は既存の `claudeEnv()` の許可リストだけで、`ANTHROPIC_API_KEY`・端末トークン・provider の設定は渡しません。

構造化出力を配布 schema と要点の形で検査し、端末トークンで `/api/client/points` に送ります。model は `sonnet`、usage は入力・出力 tokens（CLI が返した場合）、実測の duration_ms、UTC ミリ秒の turn_ended_at です。`accepted` / `already_done` だけで待ちを消します。失敗時は固定コードに加えて、本文なしの試行回数・次回時刻を `turn-retries/` に記録します。5分・30分・2時間・6時間・以後1日の間隔をあけ、待機中のターンを飛ばして後続を処理します。原文の送信済みの印とターンは残し、7日を過ぎたターンは端末の待ちから外して `turn_expired` を記録します。原文と未処理の待ちは HMP 側に残ります。モデルの出力・標準エラーは保存しません。

上限は **UTC 1日300件・1回10件・1件90秒**と `points.limits` の小さい方です。0は停止、不正値も0。試行前に `points-usage.json` に数え、失敗でも返却しません。日付が変われば再開します。すぐ処理できる端末の待ちを処理した後、同じ処理役で `/api/client/config` を取り直し、MCP 設定の検査が通り、`points.backlog` または `pending.lines` が1以上なら、`claim_turn` / `submit_points` を先に、その後 `claim_line_job` / `submit_line_blocks` を処理します。この起動も同じ件数・日次・時間の枠を使い、各段の2ツールだけを許して stream を監視します。Read は許しません。config を取り直せないときは MCP を起動しません。HMP の `claim_turn` は30分以上前の記録だけが対象です。空の claim（submit 0回）が出た段は、その処理役では再起動しません。MCP の失敗や OAuth 切れは端末のターン処理を止めません。処理中も待ちを取り直し、解除後の到着には残り予算で1回だけ再起動します。各ターンの Claude 起動前と要点送信前に一時停止・そのセッションのオフレコを再確認します。一時停止では待ちを残し、オフレコではそのセッションの待ちを捨てます。ここでは Hook が確認済みの `.hmp-ignore` を再判定しません。常駐はしません。

## 設定変更と戻し方

setup・pause は **バックアップ → diff の記録 → 戻し手順の記録 → 変更・読戻し確認** の順に実行します。`~/.hmp/backups/` と `changes/` に秘密を含まない記録を残します。既存設定への復元は表示された `manage.mjs restore <ID>` を使います。新規導入で元ファイルがない場合は自動削除せず、下のアンインストール手順を使います。setup 後の接続確認は client トークン登録と MCP 初回認証の後に verify で行います。account の origin 固定記録は秘密を含まず、restore でも削除・再割当てしません。同じ account が別 origin に移らないようにするためです。

本人の操作で `/plugin uninstall hmp@hmp-marketplace` → 処理役の終了確認 → `~/.hmp` を削除 → HMP 側で端末トークンを失効 → 必要なら本人が `security delete-generic-password -s hmp-client -a '<account>'`（移行前の旧 account が残っている場合は `<device>` も対象） を実行します。削除前に必要な設定記録を退避してください。

## 検証・配布前提

`npm test`（node:test）。全テストは一時 HOME・合成会話・偽 security/claude・ループバック HTTP のみで動きます。実 HMP・実会話・実 keychain・実 `~/.claude` は使いません。

短い実時間制限を検証するため、テストファイルは順次実行します。client keychain のテスト専用 loader は service / account に応じた合成応答を返し、偽実行ファイルの OS 起動遅延による不安定さを避けます。製品コードでは loader を使わず、認証読出し期限350msを維持します。実 CLI の OAuth プローブは一時 HOME の偽 security 実行ファイルを使います。

ループバック待受が `EPERM` / `EACCES` で拒否された場合は、診断を出してテスト専用の IPC fetch に自動で切り替えます。`HMP_TEST_TRANSPORT=ipc npm test` でも明示できます。同じモックの要求・応答を使いますが、IPC 経由では実 TCP 通信の確認にはなりません。それ以外の待受エラーは失敗として扱います。製品コードはこの経路を参照しません。CLI 検証は `node test/validate.mjs /absolute/path/to/claude`（一時 HOME）で実行できます。OAuth 往復の合成検証は `node test/oauth-probe.mjs /absolute/path/to/claude`。待受不可の環境では失敗として報告し、IPC で代替しません。`--offline` を付けると合成 OAuth 保存データの検索だけを実 CLI と偽 keychain で検証します（HTTP 成功や対話認証完了の検証にはなりません）。

配布用 release への PR は常に、main への PR は `.github/**`・`scripts/risk-gate.mjs`・`package.json`・`package-lock.json`・`.npmrc` を変えるときだけ、Kun-132 が最新コミットに付けた APPROVED レビューを必要とします。bot・コメント・古いコミットの承認は数えず、同じ承認者の後の CHANGES_REQUESTED／DISMISSED で取り消します。
それ以外の main 向け PR は CI 通過で進めます。gate は独立した `pull_request_target` workflow で base 側の設定とコードだけを使い、変更ファイルとレビューを API で取得します。PR 側のコードは checkout・実行しません。
必須チェックは `test` と `risk-gate`。配布前に本人が main/release の保護に設定し、release ブランチだけを配布してください。CODEOWNERS は同梱しています。

この環境では loopback が EPERM で拒否されるため、OAuth 往復と MCP 通信成功は未検証です。配布前には制約のない合成環境で OAuth プローブを通し、本人の端末で初回認証 → verify → SessionStart の発火と claim/submit を確認してください。古いクライアント互換、P1 段A も別途確認が必要です。既存 launchd との並行比較・停止、S10 の運用課題の解消はこのリポジトリでは行いません。

## 残さない・消す

「この会話を残したくない」「記録しないで」「オフレコで」と伝えるか `/hmp:forget` を使うと、そのセッションの以降は送信も一時保存もしません。同じセッションの未送信 spool・端末の待ち・状態ファイルも捨てます。忘却の確定時にも端末の待ちと状態ファイルを消します。送信済み分は対象件数を見せて1回確認し、了承後に HMP から消します。同じ端末・同じセッションの7日以内が対象で、それ以外は本人の MCP ツール `forget_conversation` を使います。

原文・暗号文・R2 の原本添付・要点の本文・それを根拠にした線の本文・検索索引が消えます。R2 と埋め込み索引の削除失敗は HMP が再試行します。ID・時刻・source、線のつながりと墓標を指す目印、本文なしの忘却記録は残ります。バックアップと Time Travel は保持期間まで残り、抽出のため Claude に送った分と共有済みの写しは取り戻せません。

オフレコ中は `/hmp:status` と SessionStart に「このセッションはオフレコ」と表示します。`/hmp:forget --resume` で以降だけ再開します。消した分は戻りません。既に進行中だった送信は取り消せないため、送信済み分の忘却対象に含めて確認してください。
