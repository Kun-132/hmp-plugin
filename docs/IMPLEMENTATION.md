# 0.3.0 の要点直後の線

2026-10-28。server `origin/claude/lines-after-points` の SPEC 項目7–11、`client-api.ts`、`lines/client-contract.ts`、`client-api-lines.test.ts` を参照。サーバー側は変更していない。

- `points-worker.mjs` は受理済みターンの待ちを消した後、`lines-worker.mjs` で端末の claim → モデル → submit を最大2件処理する。起動時に取り直した config の `lines` だけを使い、古いキャッシュでは有効にしない。
- `structured-output.mjs` に要点の既存 Claude/Codex 起動・出力検査・環境隔離・一時ファイル削除を移し、線でも共用する。Claude は配布 instructions を system prompt、item を標準入力に渡す。Codex は要点と同じ閉じた起動で instructions と item を標準入力に渡す。Schema は配布値をそのまま使う。
- 線の固定上限は2 claim/ターン・4 claim/処理役・600起動/UTC日・最大90秒/起動（要点の時間上限以下）。`lines.limits.{max_claims_per_turn,max_claims_per_run,max_launches_per_day,max_seconds_per_turn}` は下げる方向だけ。別の `lines-usage.json` で起動前に加算する。空の claim は日次起動数を使わず、失敗した起動は返却しない。worker の解除後再起動にも claim 数と停止状態を引き継ぐ。
- 線の例外・拒否・不正出力は固定コードだけを記録して、その実行の線を止める。記録自体の失敗も要点に伝えない。config に `lines` がない場合と404/426は無記録で省く。一時停止・ロック所有権・セッションのオフレコを claim 前・起動前・submit 前に確認する。
- 要点の300件/日・10件/回と既存 MCP の線の段は変更していない。認証・設定・信頼の操作は追加していない。`CLIENT_VERSION` は0.3.0。
- `test/lines.test.mjs` は合成データ・偽 CLI・モック応答で、新旧サーバー、accepted/already_done、Claude/Codex の固定引数・配布 Schema・送信形、失敗隔離、件数・時間・日次上限、停止を検査する。検証は `HMP_TEST_TRANSPORT=ipc npm test`（外部通信なし）。

# 2人目レビューの修正（2026-10-27）

- 入力をセッション内の順番付き配列に保持し、両側に識別子があれば `prompt_id`（Codex は `turn_id`）で、片方になければ FIFO で Stop と組む。背景の仕事が残る Stop は回答だけを覚える。完了判定には本人の言葉と答えの両方の識別子を使う。
- セッションの状態更新は排他作成の短いロックで直列化する。再試行は20ms間隔で最大600ms、10秒を過ぎたセッションロックは回収する。処理役のロックは停止済み PID だけを回収し、移動先で所有者が変わっていないことを確認する。取得と公開は排他、所有者は一意の token で区別し、各ターンの前と要点送信前に確認する。
- MCP は処理役の中で `/api/client/config` を取り直し、`points.backlog` と `pending.lines` から起動を決める。取得失敗時は起動しない。空の claim が出た段はその処理役では再開しない。HMP 側の30分条件・done 部分を文脈にする契約は、このプラグインでは変更していない。
- 処理中は端末の待ち・HMP の待ちを取り直し、共通の実行上限まで続ける。ロック解除後の到着は、残り予算を渡して1回だけ再起動する。
- Claude 起動前と要点送信前に一時停止・セッションのオフレコを再確認する。成功結果だけでなく、Claude の失敗結果でも停止を優先する。一時停止なら待ちを残し、オフレコならそのセッションの待ちと再試行情報を捨てる。作業ディレクトリの `.hmp-ignore` は再判定しない。
- 失敗したターンは、本文なしの `turn-retries/<turn-name>.json` に回数・次回時刻・固定コードを保存する。5分・30分・2時間・6時間・以後1日の間隔をあけ、その間は後続へ進む。7日を過ぎた端末の待ちは外して `turn_expired` を記録し、HMP の原文と待ちには触れない。

指摘1〜8は、失敗するテストを先に実行してから修正した。指摘3・6の古い pending は同じ回帰テストで扱い、空 claim の既存の停止動作も別に確認した。追加の検証は、並行12入力、Codex の対、処理中・ロック解除後の到着、MCP の待ち増加と10件上限、回収中のロック差替え、同時6処理役、途中の停止、再試行間隔・7日経過を含む。既存テストの即時再試行とキャッシュ依存の期待値は新しい仕様に合わせた。

`npm test`：全155テスト成功（失敗0・スキップ0）。`git diff --check` も成功。この環境はループバック待受が EPERM のため、既存のテスト専用 IPC に自動切替した。実 TCP・実 MCP の通信成功は未確認。実 HMP・実 MCP・実 keychain・実会話・実 HOME は使っていない。禁止された `.github/**`・`package.json`・`scripts/risk-gate.mjs` は変更せず、commit していない。

---

# 0.2.0 の実装・検証記録

2026-10-27。HMP 作業木の `EXPERIENCE_RULES.md`、`SPEC-experience-rules-impl.md`（プラグイン 0.2.0・実装に入るときに決めた細部）、`src/points.ts`・`src/client-api.ts`、文分割の `src/meaning.ts` を読み、参照元は変更していない。

- `config.mjs`・README の契約版は 0.2.0。manifest の version は従来どおり省略。
- `client.mjs` は配布された points 契約を保持し、Hook が origin を固定して保存する。`events.mjs` は受領印に capture_id を足す。
- `turns.mjs` は固定＋追加の自動通知判定、origin/セッションごとの小さな状態、1ターン1ファイルの待ち、HMP と同じ番号付き文分割、本文なしの失敗コードを受け持つ。
- `hook.mjs`・hooks.json は Stop を非同期化。背景の仕事がない Stop で待ちを作り、処理役を切り離す。points の契約がある SessionStart では重い抽出を起動しない。
- `points-worker.mjs` は spool → capture ID → ツールなし Sonnet → 出力検査 → client/points の順に動く。受理と already_done だけで待ちを消す。失敗はコードと時刻だけを残し、次回再試行する。固定上限は300件/UTC日・10件/回・90秒/件。サーバーは下げる方向にだけ指定できる。
- `worker.mjs` は共通ロックと既存の環境許可リストを使う。新経路の MCP は端末の待ちが空のときだけ、claim_turn/submit_points → claim_line_job/submit_line_blocks の順。各段の2ツールだけを許可し Read も拒否する。旧契約の起動・ツール・上限は従来どおり。
- `offrecord.mjs`・`forget.mjs` は、そのセッションの待ちと状態も消す。`manage.mjs`・status/forget/pause の SKILL.md は表示と破棄対象を更新。

実装で決めた細部：

- HMP の usageSchema に合わせ、turn_ended_at は UTC のミリ秒、duration_ms は子の起動から終了までの実測値。tokens は CLI が返した数値だけを添える。
- 300件の日次予算は端末共通。失敗・MCP の要点と線の試行も起動前に数え、10件/回と90秒/件を共通で適用する。
- 同じ Stop の再実行で別の待ちを作らない。回答がなくても本人の言葉があるターンは処理する。空の Stop は状態を増やさない。
- 現在の origin の待ちだけを status の turns に数える。最後の失敗は成功後も履歴として保持し、本文を持たせない。
- 必要な capture ID がまだないターンは保留し、ほかの準備済みターンは進める。端末の待ちが1つでも残る間は MCP の待ちを取りに行かない。
- 既存のロックがあれば Hook は子の起動を省く。排他の確定は worker.lock の排他作成で行い、残ったロックは自動奪取しない。

`claude --help` で `-p`・`--model`・`--tools`・`--strict-mcp-config`・`--setting-sources`・`--settings`・`--no-session-persistence`・`--output-format`・`--json-schema` を確認済み。追加の `--disable-slash-commands`・`--no-chrome`・`--permission-mode`・`--permission-prompts` も存在する。代替フラグは不要。モデルの実呼出しはしていない。

検証は一時 HOME、合成会話、偽 claude/security、ループバック HTTP（待受禁止時は既存のテスト専用 IPC）だけ。`test/points.test.mjs` に、自動通知、背景の仕事、文分割、capture ID と usage、失敗/時間切れ/5xx と再試行、忘却/オフレコ、環境変数遮断、日次/回/時間上限、MCP の順序・失敗分離、旧経路との切替、origin 分離、共通ロックのテストを追加した。実 HMP・実会話・実 keychain・実 ~/.claude は使っていない。commit・push・PR は行っていない。

`npm test`：全122テスト成功（失敗0・スキップ0）。この環境ではループバック待受が EPERM のため、テスト専用 IPC へ自動切替した。実 TCP・実 MCP の通信成功は検証に含まない。`git diff --check` も成功。

変更ファイル（22ファイル）：

- `README.md`、`docs/IMPLEMENTATION.md`
- `plugins/hmp/hooks/hooks.json`
- `plugins/hmp/scripts/` の `client.mjs`、`config.mjs`、`events.mjs`、`forget.mjs`、`hook.mjs`、`manage.mjs`、`offrecord.mjs`、`worker.mjs`、新規 `points-worker.mjs`・`turns.mjs`
- `plugins/hmp/skills/forget/SKILL.md`、`plugins/hmp/skills/pause/SKILL.md`、`plugins/hmp/skills/status/SKILL.md`
- `test/helpers.mjs`、`test/forget.test.mjs`、`test/hook.test.mjs`、`test/manage-onboard.test.mjs`、`test/manifest.test.mjs`、新規 `test/points.test.mjs`

追加テスト名（`test/points.test.mjs`、26件）：

- `automated prefixes, including server additions, never spool, queue or send a prompt`
- `automated notification clears an earlier human prompt and fixed prefixes also work without points`
- `Stop queues only with absent or empty background tasks, stores redacted previous/prompt/response privately`
- `sentence boundaries match HMP including decimal dots, whitespace, Unicode and 900 UTF-16 units`
- `worker flushes events then submits structured points with capture IDs, sentences and numeric usage`
- `claude_failed: raw receipts and queued turn survive, status is code-only, next launch retries`
- `claude_timeout: raw receipts and queued turn survive, status is code-only, next launch retries`
- `output_invalid: raw receipts and queued turn survive, status is code-only, next launch retries`
- `points_unavailable: raw receipts and queued turn survive, status is code-only, next launch retries`
- `event 5xx leaves both spool and turn intact; a later run flushes and succeeds`
- `already_done completes a turn; other receipt statuses preserve it`
- `offrecord and confirmed forget remove only that session state/turns, across origins`
- `pause creates no spool, turn or session state`
- `ignore creates no spool, turn or session state`
- `remote-pause creates no spool, turn or session state`
- `points limits can only lower hard maxima; daily and run limits count failures before launch and reset by UTC`
- `JSON output validation and isolated CLI args reject malformed output`
- `tool-free timeout kills the process group and returns only the reason code`
- `pending server work runs only after local turns, points before lines, with exactly two MCP tools`
- `MCP OAuth failure stays in its stage and cannot block a subsequent local turn`
- `a missing capture leaves that turn, processes later ready turns, and suppresses MCP until drained`
- `SessionStart caches server contract/prefixes but never starts points work; legacy path stays unchanged`
- `turns, session state and config cannot cross instance origins`
- `verify selects the points pair on contract instances without claiming a turn`
- `a prompt-only Stop queues available parts and empty Stops create no state`
- `points workers share the exclusive lock and preserve per-session previous capture IDs`

以下は過去の版の記録。

---

# 初版 0.1.0 の実装・検証記録

2026-10-24。作業開始時は空の main ブランチ、未コミット変更なし。設計 `JUDGMENT_LINES_THREE_TIERS_DRAFT.md` §18 全体を読み、既存 `extraction-launchd/worker.mjs` の部分 stream 監視・環境隔離と `conversation-capture-v2/contract.py` の最小伏せ字を参照した。参照元は変更していない。

## 作成ファイル

```text
.claude-plugin/marketplace.json
.github/CODEOWNERS
.gitignore
README.md
package.json
docs/IMPLEMENTATION.md
plugins/hmp/.claude-plugin/plugin.json
plugins/hmp/hooks/hooks.json
plugins/hmp/scripts/client.mjs
plugins/hmp/scripts/config.mjs
plugins/hmp/scripts/events.mjs
plugins/hmp/scripts/hook.mjs
plugins/hmp/scripts/manage.mjs
plugins/hmp/scripts/onboard.mjs
plugins/hmp/scripts/state.mjs
plugins/hmp/scripts/worker.mjs
plugins/hmp/skills/setup/SKILL.md
plugins/hmp/skills/pause/SKILL.md
plugins/hmp/skills/status/SKILL.md
plugins/hmp/skills/onboard/SKILL.md
test/helpers.mjs
test/hook.test.mjs
test/ipc-fetch.mjs
test/manage-onboard.test.mjs
test/manifest.test.mjs
test/validate.mjs
test/worker.test.mjs
```

## 境界と判断

| 設計の対策 | 実装・残る前提 |
| --- | --- |
| S1 | 依存ゼロ、CODEOWNERS。main/release の保護・本人承認必須・release 配布は公開前に本人が設定する |
| S2/S8 | 固定の5 MCP、Read は一時ディレクトリのみ、strict MCP・設定源なし・全Hook無効・dontAsk。部分 stream と完成 input の両方を監視。本文は信頼できないデータと明示 |
| S3/S7 | client token を keychain（他OSは環境変数）から読む。HTTPS・リダイレクト拒否。設定後に client/config の instance_label を本人に見せる。scope・90日・失効・端末記録は HMP 側 |
| S4 | prompt/最終回答だけ、保存前伏せ字、再送時にも伏せ字。伏せ字は最小規則であり、完全な検出ではない |
| S5 | 除外・pause は spool 作成より前に判定。実体パスの親も検査。onboard もプレビューと送信時に検査 |
| S6 | 固定最大24起動/UTC日・8件/回・20分/回とサーバー値の小さい方。排他ロック・起動前の日次記録・プロセスグループの時間制限 |
| S9/S10 | 暗号化/P1 段A・既存運用の未解消事項はサーバー/運用側の前提として残す。実運用は変更していない |

Read の外部パス境界設定を古い CLI が黙って無視しないよう、処理役だけは Claude Code 2.1.309 以上を必要とする。ロックの自動奪取は行わず、異常終了後は停止を本人が確認して解除する。MCP 接続ファイルにはトークン・headersHelper・command を置かない。MCP の別途認証は実環境で確認が必要。

設定変更は `manage.mjs` に集約し、バックアップ → diff/戻し手順の記録 → 変更 → 読戻し確認を行う。既存の秘密らしい未知フィールドを見つけた設定はバックアップせず拒否する。新規導入を戻す場合の削除は自動実行しない。実 HOME の設定変更は今回行っていない。

## 検証

- `HMP_TEST_TRANSPORT=ipc npm test`：合成データの37テスト成功。Hook の各イベント・障害・再送・200件上限・冪等・伏せ字・権限、処理役の固定ツール・上限・ロック・即時終了、設定復元、了承付き過去ログ取込、manifest を検証する。
- `npm test`：この環境は `listen EPERM 127.0.0.1` で待受を拒否したため、TCP 経由の検証は未確認。通常の環境ではこちらがローカル HTTP モックを起動する。IPC 版は同じ応答処理を使うが TCP の代替証明にはならない。
- `node test/validate.mjs <path-to-claude>`：Claude Code 2.1.309、一時 HOME、合成の認証設定で `plugin validate .` と `plugin validate plugins/hmp` はともに exit 0。指定どおり version を省略しているため warning が出る。公式ディレクトリへの登録検査では LICENSE 不足と icon 不足の指摘がある（ローカル検証の成功判定とは別）。ライセンスの選択は行っていない。

実 Claude Code の Hook 発火・実 MCP 接続/認証・実 keychain・実 HMP・実会話・自動更新・GitHub 保護設定・既存 launchd との比較は未確認。push・PR・deploy・GitHub リポジトリ作成・HMP 書き込みは行っていない。

ローカルコミットは `git add` の段階で `.git/index.lock: Operation not permitted` により実行不能だった。このセッションでは `.git` が読み取り専用で、承認を要求できない環境のため、作成ファイルを未追跡のまま残した。

参照：[Plugins](https://code.claude.com/docs/en/plugins)、[Hooks](https://code.claude.com/docs/en/hooks)、[Manifest](https://code.claude.com/docs/en/plugins-reference)、[Marketplace](https://code.claude.com/docs/en/plugin-marketplaces)、[CLI](https://code.claude.com/docs/en/cli-reference)、[Permissions](https://code.claude.com/docs/en/permissions)。

## plugin-fix-1（2026-10-24）

作業開始時の未コミット変更はなし。実 HMP・実会話・実 keychain・実 `~/.claude` は使用していない。設定ファイルの変更は合成テスト用の一時 HOME 内のみ。

- Unicode テストの失敗を通常のコマンドで再現すると、Hook 実行前のモック HTTP 待受で `listen EPERM 127.0.0.1` になった。既存の IPC モック経由では変更前の対象テストと全37テストが成功した。確認できた原因はテスト基盤の待受制限で、Unicode デコードの実装や64 KiBの期待値の不一致ではない。テスト側を修正し、待受の `EPERM` / `EACCES` に限り既存の IPC モックへ切り替えて診断を出す。それ以外のエラーは失敗させる。
- UTF-8 の3バイト文字と4バイト文字の途中、32 KiB位置で stdin を分割する検証を追加した。64 KiBちょうどの本文は送信し、1バイト超過・100,000バイトの本文は送信も spool 保存もせず exit 0になる。
- `session` は Hook 入力の `session_id` をそのまま保存・送信し、`kind` は `prompt` / `response` を必須とする。共通の makeEvent / flush を使う onboard でも同じ形式になる。client_event_id は従来どおり session_id の hash・turn・kind から計算し、送信済み記録との互換性を保つ。旧形式の spool は元の session_id を復元できないため送信せず保持する。64桁の16進文字列である生の session_id は正常に送信できる。
- SessionStart は additionalContext に `HMP: get_context_packet を呼ぶときは session_id=<入力の session_id> を渡す` を1行返す。値は加工しない。本文・トークン・サーバー由来の自由文は出力しない。固定の更新案内は同じ JSON の additionalContext に改行で追加する。設定・認証・通信の失敗時も session の案内を返し、除外・停止中は無出力を維持する。

`node --test test/*.test.mjs`：合成データの41テストすべて成功。今回の環境は待受を `EPERM` で拒否するため、診断どおり IPC モックに自動切替して検証した。実 TCP 通信・実 MCP 呼出しの検証は含まない。`git diff --check` も成功。push・PR・deploy は行っていない。

本人からローカルコミットの許可を得たが、`git add` が `.git/index.lock: Operation not permitted` で失敗した。環境の `.git` 読み取り専用制約により、今回の変更は未コミットで残している。
