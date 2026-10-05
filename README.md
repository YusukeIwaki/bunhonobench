# bunhonobench

Ruby+Sinatra+ActiveRecord と Bun+Hono+drizzle で同じ記事サイトを作り、
並列アクセス時のパフォーマンス差を数字で比較するベンチマーク。

両方とも同じ Postgres 上の同じデータに同じクエリを投げ、ほぼ同じ HTML を返す。
`/articles.html`（一覧、500件・約234KB）→ `/articles/13.html`（詳細、2クエリ）の構成。

## 構成

| | Ruby | Bun |
|---|---|---|
| アプリ | Sinatra + ActiveRecord | Hono + drizzle-orm |
| サーバ | Puma（1プロセス、スレッド 4–16） | Bun.serve（イベントループ） |
| DB接続 | ActiveRecord pool 16 | pg Pool 20 |
| ポート | http://localhost:4567 | http://localhost:3000 |

- DB: Postgres 15（Docker、両アプリで共有、read-only ワークロード）
- データ: 記事 500件（`db/gen_seed.rb` で生成、決定的な内容）
- 一覧: `SELECT * FROM articles ORDER BY id DESC`（1クエリ）
- 詳細: `SELECT * WHERE id = ?` + 最新5件（2クエリ、サイドバー用）
- 両者の出力 HTML はスタック名の表記と空白以外は同一であることを diff で確認済み

## 測定条件

- マシン: Apple M3（8コア）、macOS、同一マシン内でサーバ・DB・負荷クライアントを実行
- バージョン: Ruby 3.4.9 / sinatra 4.2.1 / activerecord 8.1.4 / puma 6.6.1 / pg 1.7.0、
  Bun 1.4.0 / hono 4.13.13 / drizzle-orm 0.44.7 / pg 8.23.1
- シナリオ detail: `GET /articles/{ランダム1–500}.html` × 3000リクエスト
- シナリオ list: `GET /articles.html` × 500リクエスト
- 両ターゲットに同一のリクエスト列（seed 固定の乱数）を投げ、順番に計測（同時負荷なし）
- 各ターゲット計測前にウォームアップ 300リクエスト
- 計測スクリプト: `bench/bench.mjs`（同時接続数ごとの req/s、平均、p50/p95/p99 を集計）
- 全条件で3回計測し、同じ傾向になることを確認（生データは `bench/results/*.json`）

## 結果（3回目のラン、他2回も同傾向）

### detail: ランダム記事の詳細ページ（2クエリ、約2.7KB）

| conc | Ruby req/s | Bun req/s | Ruby p50 | Bun p50 | Ruby p95 | Bun p95 | Ruby p99 | Bun p99 | Ruby err | Bun err |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 770.1 | 994.7 | 1.09ms | 0.87ms | 2.38ms | 1.75ms | 3.74ms | 2.98ms | 0 | 0 |
| 10 | 2513.9 | 4720.2 | 3.61ms | 1.85ms | 5.96ms | 3.94ms | 8.16ms | 5.53ms | 0 | 0 |
| 50 | 1673.9 | 5344.0 | 5.79ms | 7.79ms | 140.41ms | 14.34ms | 286.37ms | 54.87ms | 0 | 0 |
| 100 | 1411.4 | 5394.1 | 6.31ms | 17.46ms | 390.60ms | 25.00ms | 925.76ms | 48.35ms | 0 | 0 |
| 200 | 2777.3 ※ | 5452.5 | 0.18ms ※ | 35.05ms | 587.05ms ※ | 46.90ms | 1065.41ms ※ | 56.85ms | 2555 | 0 |

※ Ruby c=200 は 3000件中 2555件が接続エラー（即時失敗）で、req/s・パーセンタイルは比較対象外。
成功したのは 445件のみ。Bun は 3000件すべて成功。

### list: 記事一覧ページ（500件取得、約234KB）

| conc | Ruby req/s | Bun req/s | Ruby p50 | Bun p50 | Ruby p95 | Bun p95 | Ruby p99 | Bun p99 | Ruby err | Bun err |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 49.8 | 159.8 | 19.45ms | 5.67ms | 23.70ms | 9.95ms | 26.93ms | 12.96ms | 0 | 0 |
| 10 | 56.1 | 181.7 | 176.22ms | 54.02ms | 198.33ms | 72.74ms | 218.78ms | 82.32ms | 0 | 0 |
| 50 | 55.9 | 163.5 | 287.29ms | 287.33ms | 5816.70ms | 408.30ms | 6082.03ms | 432.89ms | 0 | 0 |

## 読み解き

- **detail（IO待ち中心）**: Bun は同時接続 200 まで req/s・p99 ともに安定（約5400 req/s、p99 約50ms）。
  Ruby はスレッド16本を使い切るとキューイングが始まり、c=50 付近から p95/p99 が悪化、
  c=200 では接続の受け付け自体が追いつかず約85%が接続エラーになった。
  これが non-blocking IO（イベントループ）とブロッキングIO（スレッドプール）の差として現れている。
- **list（レンダリング中心）**: 1リクエストの処理自体が Ruby 約20ms・Bun 約5ms と差があり、
  Ruby は並列数を上げても約55 req/s で頭打ち（シングルスレッドの処理時間が律速）。
  Bun は約3倍のスループット。
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

# 5. ベンチマーク（リポジトリルートで）
bun bench/bench.mjs
# 同時接続数の変更例: bun bench/bench.mjs --detail-levels=1,10,50 --list-levels=1,10
```

環境変数で変更可能: `DATABASE_URL`（両アプリ共通）、`PORT`、`PUMA_MAX_THREADS`、`DB_POOL`、
`RUBY_URL` / `BUN_URL`（ベンチ対象）。
