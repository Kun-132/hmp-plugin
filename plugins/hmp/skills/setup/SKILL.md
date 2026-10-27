---
name: setup
description: HMP の接続先・端末名・認証・処理役を設定・確認
disable-model-invocation: true
---
秘密を聞く・トークンのチャット貼付・keychain 読出しは禁止。

1. 未導入: `/plugin marketplace add https://github.com/Kun-132/hmp-plugin#release` → `/plugin install hmp@hmp-marketplace` → `/plugin` の hmp-marketplace 自動更新 on。
2. 本人が `<インスタンスURL>/authorize/connect` で Google ログイン・同意→端末名で client トークン発行（表示1回、再発行不要）。
3. 同じ HTTPS URL・端末名（英数字・._-、64字以内）で `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" setup <URL> <device>`（シェル引用）。バックアップ・diff・戻し手順・verified 確認。keychain.account で `security add-generic-password -s hmp-client -a '<account>' -w` を示し本人が入力欄に貼る（更新のみ -U）。他 OS: 本人が HMP_CLIENT_TOKEN・発行先 origin の HMP_CLIENT_ORIGIN を設定（ファイル保存禁止）。
4. Claude Code 2.1.309 以上で通常ログイン後、本人が `claude mcp add --transport http --scope user hmp '<インスタンスURL>/mcp'`。URL=instance_url + /mcp。同名は本人が `claude mcp get hmp` で確認（上書き禁止）。同じユーザー・HOME・CLAUDE_CONFIG_DIR で `claude --strict-mcp-config --mcp-config "$HOME/.hmp/mcp.json" --setting-sources '' --settings '{"disableAllHooks":true,"enabledPlugins":{}}'` を起動、/mcp→同じ hmp→Authenticate→ブラウザ認証。別名認証流用・headers への秘密移動禁止。
5. 同じ manage.mjs の `verify`（最大30秒、モデル料金発生、claim/submit 拒否）で instance_label・worker.ready=true 確認。失敗は未完了。通常ログイン・keychain ロック・同じ /mcp の再認証を案内。

origin 変更は新 account。同ホストの port/scheme 変更は新端末名で発行・setup。旧 account は移行前 origin 固定時のみ。spool は不一致・不明 origin を保留（status.spool_held）、再割当禁止。

任意: manage.mjs `codex-hooks install`（確認 status、解除 remove）。新規 Hook は本人の Codex 画面の信頼操作まで動かない（`config.toml` の `hooks.state`）。殻は信頼の印を書かない。
Claude Code 起動の Codex（エージェントの仕事）は `CLAUDECODE` で保存・送信しない。Claude アプリ内ターミナルでも同扱いになりうる。
