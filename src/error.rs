use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// We never reached ClickHouse at all — wrong host, DNS, TLS, refused.
    #[error("could not reach ClickHouse at {url}: {source}")]
    Transport {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// ClickHouse answered, and it answered with an exception.
    #[error("{message}")]
    ClickHouse { code: i32, message: String },

    /// ClickHouse answered with something we could not parse.
    #[error("could not decode the ClickHouse response: {0}")]
    Decode(String),

    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    NotFound(String),

    /// A published endpoint's token was missing or wrong. Distinct from a
    /// ClickHouse credential failure, which is about Flint's own connection.
    #[error("{0}")]
    Unauthorized(String),
}

impl Error {
    pub fn decode(context: &str, err: impl std::fmt::Display) -> Self {
        Error::Decode(format!("{context}: {err}"))
    }

    /// Stable machine-readable discriminator for the frontend.
    fn kind(&self) -> &'static str {
        match self {
            Error::Transport { .. } => "transport",
            Error::ClickHouse { .. } => "clickhouse",
            Error::Decode(_) => "decode",
            Error::BadRequest(_) => "bad_request",
            Error::NotFound(_) => "not_found",
            Error::Unauthorized(_) => "unauthorized",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Error::Transport { .. } => StatusCode::BAD_GATEWAY,
            Error::Decode(_) => StatusCode::BAD_GATEWAY,
            Error::BadRequest(_) => StatusCode::BAD_REQUEST,
            Error::NotFound(_) => StatusCode::NOT_FOUND,
            Error::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            // Translate the handful of ClickHouse codes that map cleanly onto
            // HTTP so the UI can react (re-prompt for credentials, etc.).
            Error::ClickHouse { code, .. } => match code {
                // AUTHENTICATION_FAILED / WRONG_PASSWORD / UNKNOWN_USER
                194 | 193 | 192 | 516 => StatusCode::UNAUTHORIZED,
                // NOT_ENOUGH_PRIVILEGES / READONLY / ACCESS_DENIED
                497 | 164 => StatusCode::FORBIDDEN,
                // UNKNOWN_TABLE / UNKNOWN_DATABASE / UNKNOWN_IDENTIFIER
                60 | 81 => StatusCode::NOT_FOUND,
                // TIMEOUT_EXCEEDED / QUERY_WAS_CANCELLED
                159 | 394 => StatusCode::REQUEST_TIMEOUT,
                _ => StatusCode::BAD_REQUEST,
            },
        }
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = self.status();
        let code = match &self {
            Error::ClickHouse { code, .. } => Some(*code),
            _ => None,
        };
        if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
        } else {
            tracing::debug!(error = %self, "request rejected");
        }
        (
            status,
            Json(json!({
                "error": {
                    "kind": self.kind(),
                    "message": self.to_string(),
                    "clickhouse_code": code,
                }
            })),
        )
            .into_response()
    }
}
