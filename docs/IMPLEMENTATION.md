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
