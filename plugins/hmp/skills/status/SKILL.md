---
name: status
description: HMP の送信待ち・端末の要点待ち・HMP の処理待ち・クライアント版を確認する
disable-model-invocation: true
---
`node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" status "<session_id>"` を実行し、spool 件数、そのうち接続先 origin が異なるか不明で保留している spool_held 件数、最後の送信時刻、現在の origin の turns.count（端末の要点待ち件数）・turns.oldest（最古の ISO 時刻）・turns.last_failure（最後の失敗コード）、HMP の pending.extraction・pending.lines、client_version だけを簡潔に報告する。spool_held は spool の内数。pending が null なら未確認とする。session_id は Hook 入力の値を使い、offrecord=true なら「このセッションはオフレコ」と伝える。本文・トークン・spool の中身を表示しない。保留分の origin を現在の接続先に書き換えたり自動再割当てしたりしない。
