# bunhonobench

Ruby+Sinatra+ActiveRecord、Bun+Hono+drizzle、Rust+axum+sqlx で同じ記事サイトを作り、
並列アクセス時のパフォーマンス差を数字で比較するベンチマーク。

3つとも同じ Postgres 上の同じデータに同じクエリを投げ、ほぼ同じ HTML を返す。
`/articles.html`（一覧、500件・約234KB）→ `/articles/13.html`（詳細、2クエリ）の構成。

## 構成

| | Ruby | Bun | Rust |
|---|---|---|---|
| アプリ | Sinatra + ActiveRecord | Hono + drizzle-orm | axum + sqlx |
| サーバ | Puma（1プロセス、スレッド 4–16） | Bun.serve（イベントループ） | axum + tokio マルチスレッド |
| DB接続 | ActiveRecord pool 16 | pg Pool 20 | sqlx Pool 20 |
| ポート | http://localhost:4567 | http://localhost:3000 | http://localhost:8080 |

- DB: Postgres 15（Docker、3アプリで共有、read-only ワークロード）
- データ: 記事 500件（`db/gen_seed.rb` で生成、決定的な内容）
- 一覧: `SELECT * FROM articles ORDER BY id DESC`（1クエリ）
- 詳細: `SELECT * WHERE id = ?` + 最新5件（2クエリ、サイドバー用）
- 3者の出力 HTML はスタック名の表記と空白以外は同一であることを diff で確認済み
- Rust は `cargo build --release` の最適化ビルドで計測

## 測定条件

- マシン: Apple M3（8コア）、macOS、同一マシン内でサーバ・DB・負荷クライアントを実行
- バージョン: Ruby 3.4.9 / sinatra 4.2.1 / activerecord 8.1.4 / puma 6.6.1 / pg 1.7.0、
  Bun 1.4.0 / hono 4.13.13 / drizzle-orm 0.44.7 / pg 8.23.1、
  rustc 1.99.0 / axum 0.8.9 / sqlx 0.8.6 / tokio 1.53.2
- シナリオ detail: `GET /articles/{ランダム1–500}.html` × 3000リクエスト
- シナリオ list: `GET /articles.html` × 500リクエスト
- 全ターゲットに同一のリクエスト列（seed 固定の乱数）を投げ、順番に計測（同時負荷なし）
- 各ターゲット計測前にウォームアップ 300リクエスト
- 計測スクリプト: `bench/bench.mjs`（同時接続数ごとの req/s、平均、p50/p95/p99 を集計）
- 3者構成で2回計測し、同じ傾向になることを確認（生データは `bench/results/*.json`）

## 結果（2回目のラン、1回目も同傾向）

### detail: ランダム記事の詳細ページ（2クエリ、約2.7KB）

| conc | Ruby req/s | Bun req/s | Rust req/s | Ruby p50 | Bun p50 | Rust p50 | Ruby p95 | Bun p95 | Rust p95 | Ruby p99 | Bun p99 | Rust p99 | Ruby err | Bun err | Rust err |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 826.2 | 1467.6 | 944.8 | 1.12ms | 0.62ms | 0.92ms | 1.89ms | 1.01ms | 1.97ms | 2.97ms | 1.83ms | 2.71ms | 0 | 0 | 0 |
| 10 | 2614.8 | 4903.1 | 3001.3 | 3.58ms | 1.76ms | 3.05ms | 5.68ms | 4.01ms | 5.48ms | 8.03ms | 7.22ms | 8.04ms | 0 | 0 | 0 |
| 50 | 1848.3 | 5910.1 | 3597.4 | 6.05ms | 7.43ms | 13.19ms | 148.19ms | 12.69ms | 17.92ms | 289.90ms | 41.77ms | 32.48ms | 0 | 0 | 0 |
| 100 | 1674.3 | 6649.9 | 3681.1 | 5.86ms | 14.74ms | 26.07ms | 348.96ms | 18.73ms | 36.45ms | 713.60ms | 21.35ms | 43.46ms | 0 | 0 | 0 |
| 200 | 3287.0 ※ | 5870.6 | 3799.4 | 0.25ms ※ | 32.26ms | 50.37ms | 570.88ms ※ | 46.28ms | 61.79ms | 890.29ms ※ | 65.22ms | 77.44ms | 2564 | 0 | 0 |

※ Ruby c=200 は 3000件中 2564件が接続エラー（即時失敗）で、req/s・パーセンタイルは比較対象外。
成功したのは 436件のみ。Bun・Rust は 3000件すべて成功。

### list: 記事一覧ページ（500件取得、約234KB）

| conc | Ruby req/s | Bun req/s | Rust req/s | Ruby p50 | Bun p50 | Rust p50 | Ruby p95 | Bun p95 | Rust p95 | Ruby p99 | Bun p99 | Rust p99 | Ruby err | Bun err | Rust err |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 50.3 | 206.1 | 193.8 | 19.36ms | 4.26ms | 4.52ms | 23.21ms | 7.40ms | 7.77ms | 24.67ms | 9.04ms | 9.44ms | 0 | 0 | 0 |
| 10 | 55.2 | 252.5 | 236.4 | 179.96ms | 39.06ms | 40.50ms | 197.39ms | 53.21ms | 61.40ms | 207.23ms | 66.23ms | 72.21ms | 0 | 0 | 0 |
| 50 | 55.7 | 235.0 | 252.9 | 288.24ms | 201.84ms | 189.35ms | 5732.15ms | 271.82ms | 236.66ms | 6277.46ms | 284.02ms | 253.21ms | 0 | 0 | 0 |

## 読み解き

- **detail（IO待ち中心）**: Bun（約5900–6600 req/s）と Rust（約3600–3800 req/s）はいずれも
  同時接続 200 までエラーなしで安定。Ruby はスレッド16本を使い切るとキューイングが始まり、
  c=50 付近から p95/p99 が悪化、c=200 では接続の受け付け自体が追いつかず約85%が接続エラーになった。
  non-blocking IO（イベントループ / 非同期ランタイム）とブロッキングIO（スレッドプール）の差が現れている。
  なおこの条件では detail のスループットは Bun > Rust となった。
- **list（レンダリング中心）**: 1リクエストの処理自体が Ruby 約19ms に対し Bun・Rust は約4–5ms。
  Ruby は並列数を上げても約55 req/s で頭打ち（シングルスレッドの処理時間が律速）。
  Bun と Rust はほぼ互角で約4倍のスループット。
- 注意: 同一マシン・localhost 計測であり、Puma のワーカー増設やチューニングで Ruby 側の数字は改善しうる。
  あくまで「シングルプロセス・素直な設定での比較」として読むこと。

## 再現手順

```sh
# 1. Postgres を起動
docker run -d --name bunhonobench-pg \
  -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=articles \
  -p 127.0.0.1:5434:5432 postgres:15-alpine

# 2. seed を投入
ruby db/gen_seed.rb
docker exec -i bunhonobench-pg psql -U bench -d articles < db/seed.sql

# 3. Ruby アプリ（別ターミナル、rbenv で 3.4.9 を使用）
cd ruby-app && bundle install
bundle exec puma -C config/puma.rb
# -> http://localhost:4567/articles.html

# 4. Bun アプリ（別ターミナル）
cd bun-app && bun install
bun src/index.ts
# -> http://localhost:3000/articles.html

# 5. Rust アプリ（別ターミナル、release ビルド）
cd rust-app && cargo build --release
./target/release/rust-app
# -> http://localhost:8080/articles.html

# 6. ベンチマーク（リポジトリルートで）
bun bench/bench.mjs
# 同時接続数の変更例: bun bench/bench.mjs --detail-levels=1,10,50 --list-levels=1,10
```

環境変数で変更可能: `DATABASE_URL`（全アプリ共通）、`PORT`、`PUMA_MAX_THREADS`、`DB_POOL`、
`RUBY_URL` / `BUN_URL` / `RUST_URL`（ベンチ対象）。
