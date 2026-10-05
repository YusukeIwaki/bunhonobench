# frozen_string_literal: true

require 'sinatra/base'
require 'active_record'
require 'erb'

DB_URL = ENV.fetch('DATABASE_URL', 'postgres://bench:bench@127.0.0.1:5434/articles')

ActiveRecord::Base.establish_connection(
  adapter: 'postgresql',
  url: DB_URL,
  pool: ENV.fetch('DB_POOL', '16').to_i,
  prepared_statements: false
)
ActiveRecord::Base.logger = nil

class Article < ActiveRecord::Base; end

class App < Sinatra::Base
  set :views, File.expand_path('views', __dir__)
  set :logging, false
  set :show_exceptions, false

  helpers do
    def h(text)
      ERB::Util.html_escape(text.to_s)
    end

    def excerpt(body, len = 120)
      body.to_s.gsub(/\n+/, ' ')[0, len]
    end

    def fmt_time(t)
      t.utc.strftime('%Y-%m-%d %H:%M')
    end
  end

  get '/' do
    redirect '/articles.html', 302
  end

  # List: 1 query (full rows, newest first)
  get '/articles.html' do
    @articles = Article.order(id: :desc).to_a
    content_type 'text/html', charset: 'utf-8'
    erb :articles
  end

  # Detail: 2 queries (1 row by id + latest 5 for sidebar)
  get '/articles/:id.html' do
    @article = Article.find_by(id: params[:id].to_i)
    halt 404, erb(:not_found) if @article.nil?

    @latest = Article.order(id: :desc).limit(5).to_a
    content_type 'text/html', charset: 'utf-8'
    erb :article
  end

  not_found do
    content_type 'text/html', charset: 'utf-8'
    erb :not_found
  end
end
