---
name: onboard
description: 指定期間の過去の質問と最終回答を、本人の了承後に HMP へ送る
disable-model-invocation: true
---
期間を本人に聞く（タイムゾーン付き ISO 日時、開始を含み終了を含まない）。`node "${CLAUDE_PLUGIN_ROOT}/scripts/onboard.mjs" preview <開始> <終了>` を引用した引数で実行する。本文は表示しない。
返された期間と件数を見せ、「この期間の質問と最終回答を HMP に送ってよいか」と本人の明示的な了承を取る。了承前に send を実行しない。
了承された plan と count を使い `node "${CLAUDE_PLUGIN_ROOT}/scripts/onboard.mjs" send <plan> <count> --approved` を実行する。未送信分は spool に残り、次の SessionStart で再送される。過去ログ取込後の手順 onboard_history は HMP 側の案内に従う。ツール出力や途中の assistant、subagent は送らない。
