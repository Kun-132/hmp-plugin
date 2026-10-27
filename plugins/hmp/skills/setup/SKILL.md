---
name: setup
description: HMP の接続先・端末名・認証・処理役を設定・確認
disable-model-invocation: true
---
秘密を聞かず、トークンをチャットに貼らせず、keychain の値を読まない。

1. 未導入時 `/plugin marketplace add https://github.com/Kun-132/hmp-plugin#release` → `/plugin install hmp@hmp-marketplace` → `/plugin` → Marketplaces → hmp-marketplace の自動更新 on。
2. 本人が `<インスタンスURL>/authorize/connect` で Google ログイン → 同意 → 端末名で client トークン発行。表示は1回。発行済みなら再発行不要。
3. 同じ HTTPS URL・端末名（英数字・._-、64文字以内）で `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" setup <URL> <device>`。引数はシェル引用。バックアップ・diff・戻し手順・verified を確認。戻り値 keychain.account を使い `security add-generic-password -s hmp-client -a '<account>' -w` を表示。本人が入力欄へトークンを貼る。更新時だけ -U。他 OS は HMP_CLIENT_TOKEN と発行先 origin の HMP_CLIENT_ORIGIN を本人が設定し、ファイルに保存しない。
4. Claude Code 2.1.309 以上で通常ログインし、本人が `claude mcp add --transport http --scope user hmp '<インスタンスURL>/mcp'`。URL は保存した instance_url + /mcp。同名設定は上書きせず本人が `claude mcp get hmp` で確認。同じユーザー・HOME・CLAUDE_CONFIG_DIR で `claude --strict-mcp-config --mcp-config "$HOME/.hmp/mcp.json" --setting-sources '' --settings '{"disableAllHooks":true,"enabledPlugins":{}}'` を開き、/mcp の同じ hmp を Authenticate、ブラウザ認証。別名認証を流用せず headers に秘密を移さない。
5. 登録後 `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" verify`。最大30秒、モデル利用分が発生。claim/submit は拒否。instance_label と worker.ready=true を確認。失敗時は未完了。通常ログイン・keychain ロック・同じ設定の /mcp 再認証を案内。

origin 変更時は新 account。同じホストで port/scheme が変わる場合は新しい端末名で発行・setup。旧 account は移行前 origin 固定時のみ。origin 不一致・不明の spool は保留（status.spool_held）。origin 再割当はしない。

任意（Codex の端末だけ）: 同じ manage.mjs の `codex-hooks install` / `status` / `remove`。
