//! Signing in, signing out, and asking who you are.
//!
//! Three routes that must stay reachable without a session, for the obvious
//! reason. See `src/auth.rs` for why the credentials are ClickHouse's own.

use axum::extract::State;
use axum::http::{header::SET_COOKIE, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::auth::{self, Identity};
use crate::error::{Error, Result};

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub user: String,
    /// A ClickHouse user may legitimately have no password, and on a laptop
    /// most do. Absent and empty are the same thing here.
    #[serde(default)]
    pub password: String,
    /// The server to sign in to, where this Flint has none of its own.
    ///
    /// Required unpinned, and *refused* pinned rather than ignored. Ignoring it
    /// is the tempting reading and the wrong one: a caller who sent an address
    /// and was answered `200` has every reason to believe it was used, and a
    /// pinned Flint that took the field would be an open proxy behind a manifest
    /// promising it is not. Refusing says which of the two Flints this is.
    #[serde(default)]
    pub endpoint: Option<String>,
    /// Take the session as a bearer token in the body instead of as a cookie.
    ///
    /// Opt-in, and exclusive, for one reason each. Opt-in because the cookie is
    /// `HttpOnly` precisely so that no script can read the session id, and
    /// returning it in the body of every sign-in would hand it to any script
    /// that can call this route — undoing that for the browser in order to
    /// serve a caller that is not one. Exclusive because a caller that asks for
    /// a bearer has just said it is not a browser, and setting a cookie as well
    /// would put a second copy of the same secret somewhere nobody is watching
    /// it.
    #[serde(default)]
    pub bearer: bool,
}

/// Who is asking, and whether Flint is asking anybody.
///
/// Never 401s: this is the question a browser asks *before* it can know whether
/// it needs to sign in, and answering it with the very error it is trying to
/// avoid would be a loop.
pub async fn whoami(State(state): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    let required = state.config.sign_in_required();
    let session = if required {
        auth::session_id(&headers).and_then(|id| state.sessions.resolve(&id))
    } else {
        None
    };
    let user = match (&session, required) {
        (Some(identity), _) => Some(identity.user().to_string()),
        // Not signed in — nobody is — but the name is still worth having: it is
        // the account every statement will run as, and the UI says so rather
        // than leaving somebody to wonder whose grants they are hitting.
        (None, false) => Some(state.config.clickhouse_user.clone()),
        (None, true) => None,
    };

    Json(json!({
        "required": required,
        "user": user,
        // Which server *this session* is on. Unpinned that is not a fact about
        // the deployment — two people signed into one Flint can be on two
        // different ClickHouses — so it is answered here rather than on
        // `/api/config`, which falls back to the manifest's endpoint where there
        // is one and to null where there is not.
        "endpoint": session
            .as_ref()
            .and_then(|identity| identity.endpoint())
            .or_else(|| state.config.redacted_endpoint()),
        // What signing out would leave you as. Null unpinned: signing out
        // leaves you as nobody, because there is no account in the manifest to
        // fall back to — which is why the sign-in screen there asks for a server
        // as well as a name.
        "service_user": state
            .config
            .pinned()
            .then(|| state.config.clickhouse_user.clone()),
        // Whether this connection had to give up Flint's own settings, which
        // happens on a `readonly=1` profile. A fact about the *connection*, like
        // the endpoint above it and for the same reason — two sessions on one
        // unpinned Flint can be on two servers, only one of which restrains it.
        //
        // On the wire because it changes what a figure means, not merely how it
        // was fetched: without `log_comment` Flint cannot leave itself out of
        // the query log, so the workload readings include Flint reading them,
        // and the pages that quote those figures say so.
        "settings_refused": match &session {
            Some(identity) => state.ch.as_user(identity).settings_refused().await,
            None => state.ch.settings_refused().await,
        },
    }))
}

/// Sign in with ClickHouse credentials.
///
/// Verification is a real query, not a lookup: `SELECT currentUser()` sent as
/// the credentials offered. If ClickHouse accepts it, they are good; if it
/// refuses, they are not, and Flint has no opinion of its own to add. It also
/// settles the *name* — ClickHouse is the authority on what the user it just
/// authenticated is called, and storing its answer rather than the form's means
/// the session, the log and the access page all agree.
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Response> {
    if !state.config.sign_in_required() {
        return Err(Error::BadRequest(
            "this Flint does not sign anyone in — it connects as the account in its manifest. \
             Set FLINT_AUTH=true to change that."
                .into(),
        ));
    }
    if req.user.trim().is_empty() {
        return Err(Error::BadRequest("a user name is required".into()));
    }

    let target = target_for(&state, req.endpoint.as_deref())?;

    #[derive(serde::Deserialize)]
    struct Whoami {
        user: String,
        /// Asked in the same round trip, because this is the one moment an
        /// unpinned Flint speaks to the server before anybody needs the answer —
        /// and the alternative is a query per request for a fact that changes
        /// only when ClickHouse restarts. See `Identity::timezone`.
        timezone: String,
    }

    // Read before the request is taken apart: `req.password` moves next.
    let wants_bearer = req.bearer;
    let mut offered = Identity::new(req.user.trim(), req.password);
    if let Some(endpoint) = &target {
        offered = offered.at(endpoint.clone());
    }
    let _dial = dial(&state)?;
    let probe = state.ch.as_user(&offered);
    let (who, zone) = match probe
        .row::<Whoami>("SELECT currentUser() AS user, timezone() AS timezone")
        .await
    {
        Ok(Some(row)) => (row.user, row.timezone),
        // A server that answers the query with no rows is not something to
        // guess about, so take the name the form gave and carry on.
        Ok(None) => (offered.user().to_string(), String::new()),
        // The credentials themselves were wrong. See `refusal`.
        Err(
            e @ Error::ClickHouse {
                code: 516 | 194 | 193 | 192,
                ..
            },
        ) => return Err(refusal(e)),
        // Accepted, and then refused for something else. Code 164 is a profile
        // that forbids *changing settings* — `readonly=1`, which is a different
        // thing from forbidding writes and is what a lot of places hand out as
        // "a read-only account".
        //
        // Reaching here now means it survived the client's own concession: see
        // `Client::relent`, which drops Flint's settings and tries again the
        // first time a server refuses them, so an ordinary `readonly=1` account
        // signs in and works. What is left is a server that will not take even
        // the format Flint parses its answers in, and there is nothing to
        // degrade to. Worth its own sentence still, because the raw message
        // names a setting and leaves somebody staring at a password field that
        // was never the problem.
        Err(Error::ClickHouse { code: 164, .. }) => {
            return Err(Error::BadRequest(format!(
                "`{}` signed in, but is on a profile so restricted that Flint cannot even ask \
                 for the response format it reads. Flint already drops its own timeout and row \
                 cap for a `readonly=1` account; this one refuses more than that. Restrict a \
                 user with grants (`GRANT SELECT ON db.*`) rather than with a readonly profile.",
                offered.user()
            )));
        }
        // Anything else — the server is unreachable, a table is missing, the
        // response was garbage — is not a credential problem either, and must
        // not be reported as one, or somebody spends the afternoon retyping a
        // correct password.
        Err(e) => return Err(e),
    };

    // The name ClickHouse gave, with the password that authenticated it — and
    // the server it authenticated *on*, which is what every request this session
    // makes will be sent to.
    let mut identity = Identity::new(who.clone(), offered.password()).cutting_dates_in(zone);
    if let Some(endpoint) = &target {
        identity = identity.at(endpoint.clone());
    }
    let id = state.sessions.open(identity);
    tracing::info!(
        user = %who,
        // Named on an unpinned Flint because "signed in" alone answers half the
        // question there: sessions on this process are not all on one server.
        endpoint = target.as_deref().unwrap_or_default(),
        sessions = state.sessions.count(),
        "signed in"
    );

    if wants_bearer {
        // `expires_in` rather than a deadline: a client that has to compare two
        // clocks to know whether its token is still good will get it wrong on
        // the machine whose clock is off, which is the one where it matters.
        // And it is an *idle* window — every call pushes it back — so a caller
        // is told the shape of what it holds rather than a moment.
        return Ok((
            StatusCode::OK,
            Json(json!({
                "user": who,
                "bearer": id,
                "expires_in": state.sessions.idle().as_secs(),
            })),
        )
            .into_response());
    }

    let cookie = auth::set_cookie(&id, auth::is_secure(&headers));
    Ok((
        StatusCode::OK,
        [(SET_COOKIE, cookie)],
        Json(json!({ "user": who })),
    )
        .into_response())
}

/// ClickHouse's rejection of a credential, trimmed to its first line.
///
/// ClickHouse appends a multi-paragraph hint to these — where to reset a cloud
/// password, which file holds the default one — and a sign-in form wants the
/// first line of that, not the essay. Shared by `login` and `preflight` so that
/// a wrong password reads the same whichever of the two met it first: the
/// preflight now usually does, and it would have been the one route answering
/// with the wall of text.
///
/// Anything that is not one of those four codes passes through untouched. A
/// transport failure is not a wrong password, and saying it is sends somebody
/// to retype a correct one.
fn refusal(e: Error) -> Error {
    match &e {
        Error::ClickHouse {
            code: 516 | 194 | 193 | 192,
            ..
        } => Error::Unauthorized(e.to_string().lines().next().unwrap_or_default().to_string()),
        _ => e,
    }
}

/// Which server this request is for, or a refusal.
///
/// Shared by `login` and `preflight` rather than written twice. It is the one
/// decision in Flint that turns a string from a browser into an address this
/// process will open a socket to, and two copies of it are two places for the
/// vetting to drift out of agreement — which is the shape of the bug nobody
/// finds until the second route is the one being used.
///
/// The branches are refusals rather than a preference resolved quietly, for the
/// reason on `LoginRequest::endpoint`.
fn target_for(state: &AppState, endpoint: Option<&str>) -> Result<Option<String>> {
    match (
        state.config.pinned(),
        endpoint.map(str::trim).unwrap_or_default(),
    ) {
        (false, "") => Err(Error::BadRequest(
            "name the ClickHouse HTTP endpoint to sign in to — this Flint has none of its \
             own. Something like http://localhost:8123."
                .into(),
        )),
        // Vetted before it is dialled: it arrived from a browser, and this
        // process is about to open a socket to it. See `src/target.rs`.
        (false, raw) => Ok(Some(
            crate::target::vet(raw, &state.config.targets).map_err(Error::BadRequest)?,
        )),
        (true, "") => Ok(None),
        (true, _) => Err(Error::BadRequest(format!(
            "this Flint is pointed at {} by its manifest, and signing in cannot move it. \
             Unset FLINT_CLICKHOUSE_URL to run a Flint whose server the browser names.",
            state.config.redacted_endpoint().unwrap_or_default()
        ))),
    }
}

/// A permit to open one outbound connection on behalf of nobody.
///
/// Taken before the socket, released when the probe returns. These are the only
/// places in Flint where an unauthenticated request causes an outbound
/// connection to an address the request chose, so they are the ones worth
/// counting — see `AppState::dials`, including what it does and does not buy.
/// Refused rather than queued: a queue of waiters is its own way to spend this
/// process's memory, and a person signing in will only meet this while
/// something else is holding every connection open, which is worth being told.
///
/// `preflight` shares the same pool as `login` deliberately. It is the same
/// socket to the same chosen address, and giving the newer route a budget of its
/// own would double what one caller can hold open while each limit looked
/// correctly small.
fn dial(state: &AppState) -> Result<tokio::sync::OwnedSemaphorePermit> {
    state.dials.clone().try_acquire_owned().map_err(|_| {
        Error::Throttled(
            "too many sign-ins are being attempted at once for Flint to open another connection. \
             Try again in a moment — and if this Flint is reachable by anyone, FLINT_TARGETS is \
             what stops its sign-in form being used to probe a network."
                .into(),
        )
    })
}

/// What these credentials would be able to do here, without signing in with
/// them.
///
/// Open, like `login`, and for the same reason: it is asked by a browser that
/// has nobody to be yet. It takes the same body, vets the same address through
/// the same function and spends a permit from the same pool — but it opens no
/// session and sets no cookie, so a caller who runs it a hundred times has a
/// hundred read-only probes and is still nobody.
///
/// Why it exists: credentials that are *accepted* and then cannot read
/// `system.query_log`, or cannot create the table an alert needs, used to be
/// discovered three clicks past this form as a page that loads and says nothing.
/// The measurement is `clickhouse::preflight`; what it means for each section is
/// decided in the frontend, which is where that judgement is testable.
pub async fn preflight(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<serde_json::Value>> {
    if !state.config.sign_in_required() {
        return Err(Error::BadRequest(
            "this Flint does not sign anyone in, so there are no credentials to check — it \
             connects as the account in its manifest."
                .into(),
        ));
    }
    if req.user.trim().is_empty() {
        return Err(Error::BadRequest("a user name is required".into()));
    }

    let target = target_for(&state, req.endpoint.as_deref())?;
    let mut offered = Identity::new(req.user.trim(), req.password);
    if let Some(endpoint) = &target {
        offered = offered.at(endpoint.clone());
    }

    let _dial = dial(&state)?;
    let ch = state.ch.as_user(&offered);
    let reading = crate::clickhouse::preflight::measure(&ch, offered.user())
        .await
        .map_err(refusal)?;

    Ok(Json(json!({
        "reading": reading,
        // Two facts about *this Flint* rather than about the server, and they
        // belong in the same answer because the screen reads them together: a
        // backup capability is the user's grants AND a disk this deployment is
        // allowed to write to, and an alert is grants AND somewhere to keep it
        // AND something that ticks. Sent here rather than left to `/api/config`
        // so the panel is assembled from one payload and cannot show half of a
        // verdict while the other half is still in flight.
        "backups": state.config.backup_disk.is_some(),
        "workspace": state.config.workspace_database,
        "scheduled": state.config.workspace_database.is_some() && state.config.pinned(),
    })))
}

/// Sign out. Idempotent: signing out when you are not signed in is not an
/// error, it is the state you asked for.
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(id) = auth::session_id(&headers) {
        state.sessions.close(&id);
    }
    let cookie = auth::clear_cookie(auth::is_secure(&headers));
    (
        StatusCode::OK,
        [(SET_COOKIE, cookie)],
        Json(json!({ "user": serde_json::Value::Null })),
    )
        .into_response()
}
