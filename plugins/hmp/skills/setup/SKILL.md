---
name: setup
description: HMP 設定・検証
disable-model-invocation: true
---
秘密の質問・貼付・keychain 読出し禁止。

1. `/plugin marketplace add https://github.com/Kun-132/hmp-plugin#release` → `/plugin install hmp@hmp-marketplace` → `/plugin` の hmp-marketplace 自動更新 on。
2. 本人が `<インスタンスURL>/authorize/connect` で Google ログイン・同意→端末名で client トークン発行（表示1回、再発行不要）。
3. 同じ HTTPS URL・端末名（英数字・._-、最大64字）で `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" setup <URL> <device>`（引用）。バックアップ・diff・戻し手順・verified 確認。keychain.account の `security add-generic-password -s hmp-client -a '<account>' -w` 入力欄に本人が貼る（更新のみ -U）。他 OS: 本人が HMP_CLIENT_TOKEN・発行先の HMP_CLIENT_ORIGIN 設定（ファイル保存禁止）。
4. Claude Code 2.1.309 以上で通常ログイン後、本人が `claude mcp add --transport http --scope user hmp '<インスタンスURL>/mcp'`。URL=instance_url + /mcp。同名は本人が `claude mcp get hmp` 確認（上書き禁止）。同じユーザー・HOME・CLAUDE_CONFIG_DIR で `claude --strict-mcp-config --mcp-config "$HOME/.hmp/mcp.json" --setting-sources '' --settings '{"disableAllHooks":true,"enabledPlugins":{}}'` を起動、/mcp→同じ hmp→Authenticate→ブラウザ認証。別名認証流用・headers への秘密移動禁止。
5. manage.mjs `verify`（30秒上限、モデル料金、claim/submit 拒否）で instance_label・worker.ready=true・engine 確認。失敗なら通常ログイン・keychain ロック・同じ /mcp 再認証を案内。
origin 変更: 新 account。同ホスト port/scheme 変更: 新端末名で発行・setup。旧 account: 移行前 origin 固定時のみ。不一致・不明 origin の spool は保留（status.spool_held）、再割当禁止。
任意: manage.mjs `codex-hooks install`（確認 status、解除 remove）。本人の Codex 画面で新規 Hook を信頼（`config.toml` の `hooks.state`）。殻は信頼変更禁止。
`CLAUDECODE` のある Codex は保存・送信しない。Claude アプリ内ターミナルも該当しうる。
p0 端末のみ: manage.mjs `engine codex`（既定・復帰: `engine claude`）。setup は保持、MCP・p1〜p3 は Claude。
