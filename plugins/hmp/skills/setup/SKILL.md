---
name: setup
description: HMP の接続先・端末名・認証を設定し、処理役まで確認する
disable-model-invocation: true
---
順を守る。秘密を聞かず、トークンをチャットに貼らせず、keychain の値を読んだり表示したりしない。

1. 未導入なら `/plugin marketplace add https://github.com/Kun-132/hmp-plugin#release` → `/plugin install hmp@hmp-marketplace` → `/plugin` → Marketplaces → hmp-marketplace の自動更新 on。
2. 本人がブラウザで `<インスタンスURL>/authorize/connect` を開き、Google ログイン → 同意 → 端末名を入れ client トークンを発行。表示は1回だけ。発行済みなら再発行しない。
3. 同じ HTTPS URL・端末名（英数字・ドット・ハイフン・下線、64文字以内）を聞き、`node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" setup <URL> <device>`。引数はシェル引用する。バックアップ・diff・戻し手順・verified を確認。戻り値 keychain.account を使い `security add-generic-password -s hmp-client -a '<account>' -w` を表示し、本人がターミナルの入力欄へトークンを貼る。更新時だけ -U。他 OS は HMP_CLIENT_TOKEN と発行先 origin の HMP_CLIENT_ORIGIN を本人が設定し、ファイルに保存しない。
4. Claude Code 2.1.309 以上で通常ログインし、本人が `claude mcp add --transport http --scope user hmp '<インスタンスURL>/mcp'`。名前 hmp・URL は保存した instance_url + /mcp・scope user。同名設定は上書きせず本人が `claude mcp get hmp` で確認。同じユーザー・HOME・CLAUDE_CONFIG_DIR で `claude --strict-mcp-config --mcp-config "$HOME/.hmp/mcp.json" --setting-sources '' --settings '{"disableAllHooks":true,"enabledPlugins":{}}'` を開き、/mcp の同じ hmp を Authenticate、ブラウザ認証する。別名の認証を流用せず headers に秘密を移さない。
5. 登録後 `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" verify`。最大30秒、短いモデル応答の利用分が発生するが claim/submit は拒否。instance_label と worker.ready=true を確認。失敗時は完了とせず、通常ログイン・keychain ロック・同じ設定の /mcp 再認証を案内する。

origin 変更時は新 account。同じホストで port/scheme が変わる場合は新しい端末名で発行・setup。旧 account は移行前 origin に固定された場合だけ使う。origin 不一致・不明の spool は保留し status の spool_held で確認。origin を割り当て直さない。
