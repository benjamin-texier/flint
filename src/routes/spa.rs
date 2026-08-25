use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

/// The built frontend, compiled into the binary so the container has no
/// runtime file dependencies. `build.rs` guarantees the directory exists.
#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/frontend/dist"]
struct Assets;

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Never let an unmatched /api/* path fall through to index.html — that
    // turns a typo'd endpoint into a confusing 200 with HTML in it.
    if path == "api" || path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, "no such endpoint").into_response();
    }

    if let Some(response) = asset(path) {
        return response;
    }
    // Client-side routing: unknown paths are app routes.
    asset("index.html").unwrap_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "the frontend has not been built — run `pnpm build` in frontend/",
        )
            .into_response()
    })
}

fn asset(path: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();

    // Vite fingerprints everything under /assets, so it is safe to cache hard.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };

    let mut response = Response::new(Body::from(file.data));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    Some(response)
}
