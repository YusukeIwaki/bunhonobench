use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::get,
};
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions};

#[derive(FromRow, Clone)]
#[allow(dead_code)]
struct Article {
    id: i32,
    title: String,
    body: String,
    created_at: chrono::NaiveDateTime,
    updated_at: chrono::NaiveDateTime,
}

// Same escaping as ERB::Util.html_escape
fn h(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// Same as Ruby/Bun: collapse newline runs to one space, take 120 chars
fn excerpt(body: &str) -> String {
    let mut flat = String::with_capacity(body.len());
    let mut prev_nl = false;
    for c in body.chars() {
        if c == '\n' {
            if !prev_nl {
                flat.push(' ');
            }
            prev_nl = true;
        } else {
            flat.push(c);
            prev_nl = false;
        }
    }
    flat.chars().take(120).collect()
}

fn fmt_time(dt: &chrono::NaiveDateTime) -> String {
    dt.format("%Y-%m-%d %H:%M").to_string()
}

fn layout(title: &str, inner: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<title>{} - 記事サイト (Rust)</title>\n</head>\n<body>\n<header><h1>記事サイト (Rust+axum+sqlx)</h1></header>\n<main>\n{}\n</main>\n<footer><p>benchmark test site</p></footer>\n</body>\n</html>\n",
        h(title),
        inner
    )
}

fn render_list(articles: &[Article]) -> String {
    let items: Vec<String> = articles
        .iter()
        .map(|a| {
            format!(
                "<li><a href=\"/articles/{}.html\">{}</a> <span>{}</span><p>{}</p></li>",
                a.id,
                h(&a.title),
                fmt_time(&a.created_at),
                h(&excerpt(&a.body))
            )
        })
        .collect();
    layout(
        "記事一覧",
        &format!("<h2>記事一覧 ({}件)</h2>\n<ul>\n{}\n</ul>", articles.len(), items.join("\n")),
    )
}

fn render_detail(article: &Article, latest: &[Article]) -> String {
    let paras: Vec<String> = h(&article.body)
        .split("\n\n")
        .map(|p| format!("<p>{}</p>", p.replace('\n', "<br>")))
        .collect();
    let side: Vec<String> = latest
        .iter()
        .map(|a| format!("<li><a href=\"/articles/{}.html\">{}</a></li>", a.id, h(&a.title)))
        .collect();
    layout(
        &article.title,
        &format!(
            "<article>\n<h2>{}</h2>\n<p>{}</p>\n<div>\n{}\n</div>\n</article>\n<aside>\n<h3>最新記事</h3>\n<ul>\n{}\n</ul>\n</aside>\n<p><a href=\"/articles.html\">一覧に戻る</a></p>",
            h(&article.title),
            fmt_time(&article.created_at),
            paras.join("\n"),
            side.join("\n")
        ),
    )
}

fn render_not_found() -> String {
    layout(
        "Not Found",
        "<h2>記事が見つかりません</h2>\n<p><a href=\"/articles.html\">一覧に戻る</a></p>",
    )
}

async fn root() -> impl IntoResponse {
    (
        StatusCode::FOUND,
        [("location", "/articles.html")],
        String::new(),
    )
}

// List: 1 query (full rows, newest first)
async fn list(State(pool): State<PgPool>) -> impl IntoResponse {
    let rows = sqlx::query_as::<_, Article>(
        "SELECT id, title, body, created_at, updated_at FROM articles ORDER BY id DESC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    Html(render_list(&rows))
}

// Detail: 2 queries (1 row by id + latest 5 for sidebar)
async fn detail(Path(name): Path<String>, State(pool): State<PgPool>) -> impl IntoResponse {
    let id: i32 = match name.strip_suffix(".html").and_then(|s| s.parse().ok()) {
        Some(id) => id,
        None => return (StatusCode::NOT_FOUND, Html(render_not_found())),
    };
    let row = sqlx::query_as::<_, Article>(
        "SELECT id, title, body, created_at, updated_at FROM articles WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .unwrap();
    let Some(article) = row else {
        return (StatusCode::NOT_FOUND, Html(render_not_found()));
    };
    let latest = sqlx::query_as::<_, Article>(
        "SELECT id, title, body, created_at, updated_at FROM articles ORDER BY id DESC LIMIT 5",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    (StatusCode::OK, Html(render_detail(&article, &latest)))
}

async fn fallback_404() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Html(render_not_found()))
}

#[tokio::main]
async fn main() {
    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://bench:bench@127.0.0.1:5434/articles".to_string());
    let pool_max: u32 = std::env::var("DB_POOL").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
    let pool = PgPoolOptions::new()
        .max_connections(pool_max)
        .connect(&db_url)
        .await
        .unwrap();

    let app = Router::new()
        .route("/", get(root))
        .route("/articles.html", get(list))
        .route("/articles/{name}", get(detail))
        .fallback(fallback_404)
        .with_state(pool);

    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap();
    println!("Rust+axum listening on http://0.0.0.0:{port}");
    axum::serve(listener, app).await.unwrap();
}
