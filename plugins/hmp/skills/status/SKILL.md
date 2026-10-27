---
name: status
description: HMP の送信待ち・端末の要点待ち・HMP の処理待ち・クライアント版を確認する
disable-model-invocation: true
---
`node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" status "<session_id>"` を実行し、spool 件数、そのうち接続先 origin が異なるか不明で保留している spool_held 件数、最後の送信時刻、現在の origin の turns.count（端末の要点待ち件数）・turns.oldest（最古の ISO 時刻）・turns.last_failure（最後の失敗コード）、HMP の pending.extraction・pending.lines、client_version を簡潔に報告する。spool_held は spool の内数。pending が null なら未確認とする。session_id は Hook 入力の値を使い、offrecord=true なら「このセッションはオフレコ」と伝える。本文・トークン・spool の中身を表示しない。保留分の origin を現在の接続先に書き換えたり自動再割当てしたりしない。

points_stats の last_24h・all は端末の経路、points_stats.mcp の last_24h・all は MCP の段として分けて報告する（合わせて保持中の最新500件以内）。両経路の件数、duration_ms_median（処理時間、表示は秒に換算）、input_tokens_median（未キャッシュ）・cache_creation_input_tokens_median（キャッシュ書き込み）・cache_read_input_tokens_median（キャッシュ読み込み）・input_total_tokens_median（入力合計）・output_tokens_median を報告する。端末の経路は受理までの秒数の中央値・p90（nearest-rank）、written_median、last_24h の dropped（直近24時間の除外合計）と dropped_by_reason（理由コードごとの合計）も報告する。backlog_history の first・latest（pending.extraction と points.backlog、ISO 時刻）も報告する。null は未確認、標本なしの中央値・p90 はデータなしとする。履歴は現在の origin の経路・数値と理由コードだけで、status で config を再取得できたときだけ待ちを記録する。
