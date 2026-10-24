---
name: pause
description: HMP の送信と一時保存を期限付きで停止・再開する
disable-model-invocation: true
---
停止する期間を分単位で確認し、`node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" pause <分>` を実行する。未指定なら60分を提案する。解除は同じコマンドの分を0にする。バックアップ・diff・戻し手順・検証結果と期限を簡潔に報告する。停止中は質問・回答の一時保存、再送、処理役の新規起動を行わない。すでに動いている処理役は終了まで動く。
