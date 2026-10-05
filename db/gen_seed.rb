# frozen_string_literal: true

# Generates db/seed.sql using only Ruby stdlib (no gems needed).
# Run: ruby db/gen_seed.rb
# Load: docker exec -i bunhonobench-pg psql -U bench -d articles < db/seed.sql

COUNT = (ARGV[0] || 500).to_i
OUT = File.expand_path('seed.sql', __dir__)

PARA = [
  'この記事は、RubyとBunのWebアプリケーションにおける並列アクセス時のパフォーマンスを比較するためのベンチマーク用テストデータです。',
  'データベースから記事の一覧を取得して一覧ページを表示し、各記事の詳細ページでは本文と最新記事のサイドバーを表示します。',
  '一覧ページでは全件を新しい順に取得し、詳細ページでは指定IDの1件と最新5件の2クエリを発行します。どちらも現実的なクエリ構成です。',
  'Bunはnon-blocking IOを活かしたイベントループで大量の同時接続をさばくことが期待され、RubyはPumaのスレッドプールでリクエストを処理します。',
  'この本文はベンチマークのレスポンスサイズを現実的なものにするため、数KB程度のテキストで構成されています。数字で差を確認しましょう。'
].freeze

def esc(str)
  str.gsub("'", "''")
end

srand(42)
base = Time.utc(2025, 1, 1)

File.open(OUT, 'w') do |f|
  f.puts 'DROP TABLE IF EXISTS articles;'
  f.puts <<~SQL
    CREATE TABLE articles (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );
  SQL
  COUNT.times do |i|
    n = i + 1
    title = "ベンチマーク記事 #{n}: RubyとBunの並列アクセス性能比較"
    body = (0...8).map { |k| PARA[(n + k) % PARA.size] }.join("\n\n")
    body += "\n\n記事番号: #{n}"
    ts = (base + (n * 3600)).strftime('%Y-%m-%d %H:%M:%S')
    f.puts "INSERT INTO articles (title, body, created_at, updated_at) VALUES ('#{esc(title)}', '#{esc(body)}', '#{ts}', '#{ts}');"
  end
end

puts "wrote #{OUT} (#{COUNT} articles)"
