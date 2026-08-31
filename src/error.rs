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

    /// Something answered at that address, and it was not ClickHouse.
    ///
    /// The third failure, and the one an unpinned Flint meets most often, because
    /// there the address is typed by hand. "Cannot reach it" and "reached it, and
    /// it said no" already send you looking in two different places; this sends
    /// you to a third — the port — and it earns its own variant because the two
    /// it used to be reported as both point somewhere wrong. A decode failure
    /// reads as a bug in Flint, and a ClickHouse exception puts a stranger's
    /// error text in ClickHouse's mouth.
    #[error("reached {url}, and what answered is not ClickHouse: {detail}")]
    NotClickHouse { url: String, detail: String },

    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    NotFound(String),

    /// A published endpoint's token was missing or wrong, or nobody is signed
    /// in where signing in is required. Distinct from a ClickHouse credential
    /// failure, which is about Flint's own connection.
    #[error("{0}")]
    Unauthorized(String),

    /// You may not, and rephrasing will not help. 401 would send somebody to
    /// sign in again and 400 would suggest a different wording; neither is true
    /// of either thing that lands here — a tier the manifest does not permit,
    /// or a grant the caller does not hold. Those two are one answer from the
    /// outside, and the message says which without the status having to.
    #[error("{0}")]
    Forbidden(String),

    /// A caller is over the quota its key carries. Separate from `Forbidden`
    /// because it is the one refusal that fixes itself: the same call, made
    /// tomorrow, works. Telling somebody they may not do a thing when what you
    /// mean is not yet sends them to ask for a permission they already have.
    #[error("{0}")]
    Throttled(String),
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
            Error::NotClickHouse { .. } => "not_clickhouse",
            Error::BadRequest(_) => "bad_request",
            Error::NotFound(_) => "not_found",
            Error::Unauthorized(_) => "unauthorized",
            Error::Forbidden(_) => "forbidden",
            Error::Throttled(_) => "throttled",
        }
    }

    /// The status this will answer with, for anything that has to write it
    /// down before the response exists.
    pub fn http_status(&self) -> u16 {
        self.status().as_u16()
    }

    fn status(&self) -> StatusCode {
        match self {
            Error::Transport { .. } => StatusCode::BAD_GATEWAY,
            Error::Decode(_) => StatusCode::BAD_GATEWAY,
            // The peer is at fault, not the request — the same reading as a
            // transport failure, which is the neighbour this belongs beside.
            Error::NotClickHouse { .. } => StatusCode::BAD_GATEWAY,
            Error::BadRequest(_) => StatusCode::BAD_REQUEST,
            Error::NotFound(_) => StatusCode::NOT_FOUND,
            Error::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Error::Forbidden(_) => StatusCode::FORBIDDEN,
            Error::Throttled(_) => StatusCode::TOO_MANY_REQUESTS,
            // Translate the handful of ClickHouse codes that map cleanly onto
            // HTTP so the UI can react (re-prompt for credentials, etc.).
            Error::ClickHouse { code, .. } => match code {
                // AUTHENTICATION_FAILED / WRONG_PASSWORD / UNKNOWN_USER
                194 | 193 | 192 | 516 => StatusCode::UNAUTHORIZED,
                // NOT_ENOUGH_PRIVILEGES / READONLY / ACCESS_DENIED
                497 | 164 => StatusCode::FORBIDDEN,
                // UNKNOWN_TABLE / UNKNOWN_DATABASE / UNKNOWN_IDENTIFIER
                60 | 81 => StatusCode::NOT_FOUND,
                // TIMEOUT_EXCEEDED and QUERY_WAS_CANCELLED fall through to 400
                // with everything else, and the comment is here because 408 is
                // the obvious answer and it is a trap.
                //
                // Chrome silently **retries** a POST that comes back 408 — the
                // status means "you took too long to send the request", so a
                // retry is the browser being helpful. The effect on a query
                // that was just killed is that the browser immediately runs it
                // again, for the full `max_execution_time`, with nothing on
                // screen to cancel: press Stop and the statement appears never
                // to stop. A statement that hit the timeout is worse still,
                // because the retry costs the whole timeout a second time.
                //
                // 504 would be the honest reading — Flint *is* a gateway to
                // ClickHouse — but `lib/reach` counts 502/503/504 as the
                // backend being unreachable, and a slow query is not an outage.
                // So: 400, with `clickhouse_code` in the body carrying the
                // distinction, which is what the UI reads anyway.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(code: i32) -> Error {
        Error::ClickHouse {
            code,
            message: String::new(),
        }
    }

    /// The regression this locks down cost an afternoon to find, and it looked
    /// like the product being broken rather than like a status code.
    ///
    /// `QUERY_WAS_CANCELLED` and `TIMEOUT_EXCEEDED` used to answer 408, which
    /// reads correctly and is wrong: Chrome retries a POST that comes back 408,
    /// so pressing Stop killed the query and the browser immediately started it
    /// again — for the whole `max_execution_time`, with nothing on screen
    /// offering to cancel the second one. What the reader saw was a statement
    /// that would not stop.
    #[test]
    fn a_cancelled_query_never_answers_408() {
        assert_eq!(ch(394).status(), StatusCode::BAD_REQUEST);
        assert_eq!(ch(159).status(), StatusCode::BAD_REQUEST);
    }

    /// And nothing else may answer it either, for the same reason: every one of
    /// these is a POST the browser would be entitled to run twice.
    #[test]
    fn nothing_answers_408() {
        for code in [0, 60, 81, 159, 164, 192, 193, 194, 394, 497, 516, 999] {
            assert_ne!(
                ch(code).status(),
                StatusCode::REQUEST_TIMEOUT,
                "code {code}"
            );
        }
    }

    /// `lib/reach` reads 502, 503 and 504 as "the backend is not there". A slow
    /// or refused *query* is not an outage, and must not be dressed as one.
    #[test]
    fn a_query_error_is_never_a_gateway_error() {
        for code in [60, 159, 164, 194, 394, 497, 999] {
            let status = ch(code).status();
            assert!(
                !matches!(
                    status,
                    StatusCode::BAD_GATEWAY
                        | StatusCode::SERVICE_UNAVAILABLE
                        | StatusCode::GATEWAY_TIMEOUT
                ),
                "code {code} answered {status}, which `lib/reach` calls an outage"
            );
        }
    }

    #[test]
    fn the_mappings_that_the_ui_acts_on_are_kept() {
        assert_eq!(ch(516).status(), StatusCode::UNAUTHORIZED);
        assert_eq!(ch(497).status(), StatusCode::FORBIDDEN);
        assert_eq!(ch(60).status(), StatusCode::NOT_FOUND);
    }
}
