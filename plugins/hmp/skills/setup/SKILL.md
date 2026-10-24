---
name: setup
description: HMP の接続先と端末名を設定し、インスタンス名を確認する
disable-model-invocation: true
---
instance URL（HTTPS）と device 名（英数字・ドット・ハイフン・下線、64文字以内）を本人に聞く。秘密値は聞かない。
`node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" setup <URL> <device>` を実行する。引数は必ずシェルで引用し、返されたバックアップ・diff・戻し手順・検証結果を確認する。
トークンは本人がターミナルで `security add-generic-password -s hmp-client -a <device> -w` を実行して入力するよう案内する。既存値の更新が必要なら本人が `-U` を追加する。値をチャットに貼らせず、こちらで読んだり表示したりしない。他 OS は本人が環境変数 HMP_CLIENT_TOKEN を設定する（ファイルに保存しない）。端末専用の client scoped token を使用する。
本人の登録完了後に `node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" verify` を実行し、返された instance_label を本人に見せ、意図した接続先か確認する。失敗時は接続完了と報告しない。
