---
name: forget
description: 本人がこの会話を残したくない・記録しないで・オフレコで、と言ったら使う。言われていないのに使わない
---
Hook 入力の `session_id`（SessionStart で渡されたこの会話の ID）を使う。推測した ID や別の会話の ID は使わない。

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/forget.mjs" "<session_id>"` を実行する。`~/.hmp/offrecord/<session_id>` を作り、このセッションの以降の Hook は送信も spool・端末の待ち・状態の保存もしない。同じセッションの spool・turns・sessions だけを捨てる。これは本人の発言が指示なので確認は不要。
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/forget.mjs" "<session_id>" --preview` で HMP に届いた対象件数を読む。本文を表示しない。失敗してもオフレコは維持し、件数を推測しない。
3. 1件以上なら「このチャットのこれまでの N 件も HMP から消しますか？取り消せません」と本人に1回だけ確認する。了承前に `--confirm` を使わない。了承後だけ、同じコマンドの `--confirm` で `/api/client/forget` を呼び、端末の待ちと状態も消す。対象は同じ端末・同じセッションの7日以内だけ。対象0件なら確認も消去も不要。
4. 結果とサーバーの `retained_notice` を1〜2行で伝える。バックアップと Time Travel は保持期間まで残り、抽出のため Claude に送った分と共有済みの写しは取り戻せない。

引数が `--resume` なら、この session_id で `forget.mjs "<session_id>" --resume` を実行する。オフレコを解除して以降だけ再開し、消した分は戻らないと伝える。
