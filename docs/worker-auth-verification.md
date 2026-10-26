# 処理役の認証検証（2026-10-26）

採用方式は Claude Code に保存済みの HMP OAuth 認証の再利用。認証情報のコピーや extractor トークンの新規配布は追加しない。HTTP の往復確認には、この実行環境の制約による未完了部分がある。

## 原因と変更

以前の setup は `hmp-client` の client scoped token だけを登録させていた。このトークンが通る `/api/client/config` の確認だけでは、別経路の `/mcp` を使う処理役の認証は確認できない。処理役も exit 0 だけを見ていたため、MCP が未認証でも検出できなかった。

setup が生成する `~/.hmp/mcp.json` をそのまま対話 Claude Code に読み込ませ、`/mcp` で **hmp / instance_url + /mcp** を認証する手順を追加した。同じ HOME と、設定している場合は同じ `CLAUDE_CONFIG_DIR` を使う。後者は処理役の環境にも引き継ぐよう修正した。

追補の点検では、client token の account が device だけで、spool に保存先 origin がなく、setup による URL 変更で旧トークンと未送信本文が新しいホストへ渡る問題も修正した。

## 接続先 origin の固定（追補）

- spool は `instance_origin` を記録し、現在の origin と完全一致するものだけ送る。origin 不明の旧 spool は setup でも再割当てせず保留する。`status` の `spool_held` は全 `spool` のうち origin 不一致・不明の件数。origin は HTTP のイベントから除き、サーバー契約を維持する。
- ローカルの spool / sent のファイル名は origin と client_event_id の組で計算する。別 origin で同じイベント ID が生じても上書き・誤った送信済み抑止をしない。HTTP の client_event_id 自体は変えない。
- keychain の service は `hmp-client`、account は `<device>@<URL.hostname>`。秘密を含まない `credential-origins/` の記録で完全な origin に固定する。同じホスト名でも scheme / port が違う origin に同じ account は再利用できず、新しい端末名を要求する。記録は0600、ディレクトリ0700、排他作成で再割当てせず、restore でも消さない。
- 移行時の旧 `<device>` account は setup 前の設定の origin にだけ固定する。初回の移行 setup が別 URL を指定しても旧トークンは新 origin では読まない。新規導入では origin 不明の旧 account を自動採用しない。非 macOS の環境変数トークンも `HMP_CLIENT_ORIGIN` の完全一致を必要とする。
- onboard のプレビューも origin を記録し、別 origin へ切替後の送信・origin 不明の旧計画の送信を拒否する。
- 導入順を release の実 URL → ブラウザ `/authorize/connect` で Google ログイン・同意・端末トークン発行 → setup が示す account の登録 → `claude mcp add --transport http --scope user hmp <instance_url>/mcp` と対話認証 → verify に統一した。user scope はプロジェクトをまたいで同名・同 URL を登録するために使う。認証時には処理役の JSON を明示し、別の local scope 設定を認証する取り違えも避ける。

verify は client API に加え、同じ MCP 設定・認証保存先・設定隔離を使った headless 接続と短いモデル応答を検証する。MCP の接続済み状態、固定5ツール、成功 result が揃った場合だけ成功する。確認時は組込みツールを無効化し、MCP に ask を設定して dontAsk で呼出しを拒否する。stream に tool_use があれば終了する。claim/submit の実行権限自体は検証しない。

## 公式文書で確認したこと

- [MCP: Authenticate with remote MCP servers](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers): `claude -p` / SDK には `/mcp` がないので、その場で OAuth を完了できない。先に対話 `/mcp` または `claude mcp login <name>` で認証する。保存済みトークンの更新、macOS headless での保存情報読出し失敗についても記載がある。
- [MCP: Project scope](https://code.claude.com/docs/en/mcp#project-scope)、[CLI: --strict-mcp-config](https://code.claude.com/docs/en/cli-reference): strict は読み込む MCP サーバーの設定を限定する。OAuth 保存情報を無効化するという記載はない。
- [Headless: Start faster with bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode): `--bare` は OAuth 保存情報・keychain を読まない。処理役には採用しない。
- [Settings: Find or create your settings files](https://code.claude.com/docs/en/settings#find-or-create-your-settings-files): `CLAUDE_CONFIG_DIR` で Claude Code の保存先を変更できる。
- [Permissions: Permission modes](https://code.claude.com/docs/en/permissions#permission-modes): dontAsk は許可確認が必要な呼出しを拒否する。verify は MCP を ask 指定し、処理用の allowedTools を付けない。

ここから「strict のまま保存済み OAuth を再利用する方式が適切」と判断した。公式文書は OAuth キャッシュの内部キーを公開契約としては説明していない。

## 手元で実行して確認したこと

`claude --version` の出力は **2.1.310 (Claude Code)**。

```sh
node test/oauth-probe.mjs "$(command -v claude)"
```

上記はローカル OAuth / MCP サーバーの `listen(127.0.0.1)` で **EPERM**。認証フロー・HTTP 往復に成功した証拠にはならない。権限を迂回せず、実 HMP へも接続していない。

```sh
node test/oauth-probe.mjs "$(command -v claude)" --offline
```

上記は exit 0。一時 HOME・一時 CLAUDE_CONFIG_DIR・偽 security と、手動作成した合成 OAuth 保存データを使用し、処理役の CLI 引数で実行した。HTTP 接続先もループバックのみ。init を受けた時点で終了させ、モデル応答を要求しない。

| 設定 | 保存トークンを返したか |
| --- | --- |
| hmp / 同じ `/mcp` URL | true |
| renamed / 同じ URL | false |
| hmp / 別の `/other` URL | false |

同名・同 URL では実 CLI の debug に `Returning tokens`、`Has refresh token: [REDACTED]` を観測した。その後は HTTP 接続も EPERM で失敗した。つまり **strict 下で保存済み合成 OAuth を検索できること**は確認したが、対話で取得したトークンの再利用・refresh・サーバー受領は未確認。合成保存データのキーは手元のバイナリの実装を参照して作成したもので、製品コードでは内部キーに依存しない。

通常モードのプローブは一時環境内で `mcp add` → ローカル OAuth ログイン → strict headless の認証付き initialize / tools/list とモデル応答、名前・URL を変えた負の対照を検証する。モデル API もローカルの合成応答のみ。プローブの HTTP 成功は、この環境では未確認なので配布前に再実行する必要がある。待受不可を成功扱いしたり IPC で代替したりしない。

## extractor 案との比較

読み取り専用で確認した HMP `src/worker.ts` は `/api/tools/<name>` で `authenticateScoped` を使う。`src/scoped-token-policy.ts` の extractor は処理5ツールに加えて `line_counts`、`list_meaning_profiles` を許可する。一方、通常の `/mcp` は OAuth 経路であり、extractor を Authorization ヘッダーに設定するだけで使えるとは確認できない。

OAuth を使えない場合の候補としては、worker 自身が scoped HTTP で claim/submit し、Claude はツール0で JSON を生成する方式の方が安全で単純な認証境界になる。トークンを Claude に渡さず、0600 の秘密入り一時 MCP 設定も不要になる。ただし claim ごとの出力契約・submit 対応を worker が実装する追加範囲が生じる。今回は保存済み OAuth の検索が実 CLI で確認でき、公式の headless 手順にも合うため追加しなかった。

## テストと残る確認

`npm test` は一時 HOME・偽 claude/security のみを使用する。接続済み/未認証、ツール不足、モデル認証失敗、空の exit 0、verify 中の tool_use、認証環境の限定、片付け、既存の固定上限と stream 制限を検証する。ループバック不可時は既存のテスト専用 IPC に切り替わるため、実 TCP の証明ではない。

最初のタスクの実行は **49件成功・0件失敗（exit 0）**。追補後の最終 `npm test` は **56件成功・0件失敗（exit 0）**、`git diff --check` も成功。別 origin / origin 不明の保留、旧資格情報の固定と新 origin への不送信、同一ホストの別 port、新規導入時の旧 account 拒否、過去ログ計画の切替拒否を追加した。

このホストでは偽 security の起動が350msを超えて timeout する場合を一時計測で観測した。その計測コードは除去した。client 用のテスト専用 loader は service / account に応じた合成応答を返し、OS のプロセス起動遅延に依存させない。偽 security 実行ファイルも一時 HOME に置き、実 CLI の OAuth プローブではそちらを使う。npm test のファイル単位の同時実行数は1。lock の競合などテスト内の並行検証は維持し、製品の認証読出し期限350ms・HTTP期限・固定最大値は変更していない。

実 CLI の plugin validate は marketplace / plugin とも exit 0（既存の version 未指定、Directory 提出向けの LICENSE / icon 不足の指摘あり）。

## 変更ファイル（両タスク合計）

| ファイル | 変更 |
| --- | --- |
| `plugins/hmp/scripts/worker.mjs` | OAuth 保存先の維持、接続・公開ツール・成功 result の検証、verify 用の呼出し拒否 |
| `plugins/hmp/scripts/config.mjs` | account 名・完全 origin の固定と旧 account 移行、環境変数トークンの origin 確認 |
| `plugins/hmp/scripts/events.mjs` | spool の origin、origin ごとの保存・送信済み記録、保留数、送信先選別 |
| `plugins/hmp/scripts/manage.mjs` | setup の登録 account / command 表示、固定記録、処理役の verify、保留数 |
| `plugins/hmp/scripts/hook.mjs`、`forget.mjs`、`onboard.mjs` | origin を含む設定の認証・保存・再送、onboard 計画の origin 確認 |
| `plugins/hmp/skills/setup/SKILL.md`、`status/SKILL.md` | 導入順、登録先、認証、保留件数の案内 |
| `README.md` | release 実 URL、導入・移行・保留・OAuth の境界 |
| `package.json` | 実時間制限を持つテストファイルの順次実行 |
| `test/helpers.mjs`、`security-exec.mjs`、`ipc-fetch.mjs`、`hook.test.mjs`、`manage-onboard.test.mjs`、`worker.test.mjs` | 隔離 fixture、偽 keychain / IPC 応答と両タスクの回帰検証 |
| `test/origin-binding.test.mjs` | 接続先切替・旧資格情報・origin 不明・同一ホスト別 port の検証 |
| `test/oauth-probe.mjs` | 実 CLI と合成 OAuth / MCP、保存情報検索の隔離プローブ |
| `docs/worker-auth-verification.md` | 根拠・結果・残る確認の記録 |

配布前の確認は、制約のない環境での合成 OAuth プローブ、本人の Mac での初回 `/mcp` 認証 → verify → SessionStart → claim/submit、keychain のロック/失効/refresh 時の再認証案内。これらの実環境操作は今回実行していない。

採用方式に必要な HMP サーバー側の変更はない。HMP ソースの変更、commit、push、PR 作成は行っていない。
