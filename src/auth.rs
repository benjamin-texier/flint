//! Who is asking.
//!
//! Flint does not have users. ClickHouse does — with roles, grants, quotas, row
//! policies and a log of what each one ran — and building a second set beside it
//! would mean two systems that can disagree about the same question. So the sign
//! in form takes *ClickHouse* credentials, the session carries them, and every
//! statement runs as that user rather than as the account in the manifest.
//!
//! What that buys, mostly by not building it:
//!
//! - **Authorisation is already written.** It is `system.grants`. A user who may
//!   not read a table is refused by the server, not by a check of ours that
//!   could be wrong, out of date, or bypassed by a route we forgot.
//! - **The audit trail is already written.** `system.query_log` carries `user`,
//!   so every statement is attributable without a table of Flint's own.
//! - **The access page changes meaning.** "Who can do what" stops being an
//!   administrator's dashboard and becomes your own standing.
//!
//! What it costs, said plainly: Flint holds the password in memory for as long
//! as the session lives, because ClickHouse's HTTP interface authenticates every
//! single request and there is nothing to hold instead. It is never written to
//! disk, never sent to the browser, and never put in a log — [`Identity`]'s
//! `Debug` is redacted so it cannot be leaked by an accident of tracing. The
//! sessions live in this process only: a sidecar that restarts asks everyone to
//! sign in again, which is the honest consequence of having no store, and cheap
//! next to the alternative of encrypting credentials into a cookie with a key
//! that dies with the same process.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, HeaderValue};
use dashmap::DashMap;

/// Name of the cookie a signed-in browser carries.
///
/// Prefixed rather than bare `session`, because Flint is deployed as a sidecar
/// and may well share a hostname with whatever else the pod serves.
pub const COOKIE: &str = "flint_session";

/// One person's ClickHouse credentials, and the server they are good on.
///
/// Cloneable because the client that carries them into a request is cloned per
/// request; the password is private and printed as nothing.
///
/// The endpoint is here because on an unpinned Flint there is nowhere else it
/// could live: the request knows only a cookie, and the session is the only
/// thing between that cookie and a socket. Pinned, it is `None` and the
/// manifest's endpoint is used — which keeps every existing deployment on the
/// path it has always taken rather than routing it through a field that is
/// always the same value.
#[derive(Clone)]
pub struct Identity {
    user: String,
    password: String,
    /// The server these credentials were checked against, where the browser
    /// named it. `None` means the one in the manifest.
    endpoint: Option<String>,
    /// The zone that server cuts its dates in, read when the credentials were
    /// checked. A fact about the *server*, kept beside the credentials for the
    /// same reason the endpoint is: it changes only when ClickHouse restarts,
    /// and the session is what outlives the request. Empty where it could not
    /// be read, and an answer then says nothing about its zone rather than
    /// naming one it is not sure of.
    timezone: String,
}

impl Identity {
    pub fn new(user: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            user: user.into(),
            password: password.into(),
            endpoint: None,
            timezone: String::new(),
        }
    }

    /// The same credentials, on a server the browser named.
    pub fn at(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into());
        self
    }

    /// The same credentials, remembering what the server said its zone was.
    pub fn cutting_dates_in(mut self, timezone: impl Into<String>) -> Self {
        self.timezone = timezone.into();
        self
    }

    pub fn user(&self) -> &str {
        &self.user
    }

    pub fn password(&self) -> &str {
        &self.password
    }

    /// Where this session connects, or `None` for the server in the manifest.
    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }

    pub fn timezone(&self) -> &str {
        &self.timezone
    }
}

/// Redacted on purpose. A struct holding a password will eventually be printed
/// by a `tracing` call somebody adds while debugging something else, and the
/// safe outcome of that is the password not being there.
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("user", &self.user)
            .field("password", &"<redacted>")
            // Worth printing: on an unpinned Flint, "which server" is the first
            // question a confusing answer raises.
            .field("endpoint", &self.endpoint)
            .finish()
    }
}

struct Entry {
    identity: Identity,
    /// Monotonic on purpose: an idle timeout measured against the wall clock
    /// can be moved by NTP, and the direction it moves decides whether
    /// everybody is signed out at once or nobody ever is.
    last_seen: Instant,
}

/// The live sessions, and how long an idle one survives.
///
/// A `DashMap` rather than a `RwLock<HashMap>`: every authenticated request
/// touches `last_seen`, so the common path is a write, and one lock over the
/// whole table would serialise requests that have nothing to do with each other.
#[derive(Clone)]
pub struct Sessions {
    live: Arc<DashMap<String, Entry>>,
    idle: Duration,
}

impl Sessions {
    pub fn new(idle: Duration) -> Self {
        Self {
            live: Arc::new(DashMap::new()),
            idle,
        }
    }

    /// Start a session and return its id, which becomes the cookie.
    ///
    /// The id is a v4 UUID: 122 random bits from the platform's CSPRNG. It is a
    /// bearer token, so it is the only secret standing in front of somebody's
    /// database credentials — hence random rather than derived from anything
    /// about the user, and never logged.
    pub fn open(&self, identity: Identity) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.live.insert(
            id.clone(),
            Entry {
                identity,
                last_seen: Instant::now(),
            },
        );
        // Opportunistic, and here rather than on a timer: sign-ins are rare and
        // sweeping is cheap, so this is the one place where paying for it is
        // free. Without it, a long-lived Flint accumulates the sessions of
        // everyone who ever closed their laptop.
        self.sweep();
        id
    }

    /// Whose session this is, if it is still one. Touches it, so a session that
    /// is being used does not expire under its user.
    pub fn resolve(&self, id: &str) -> Option<Identity> {
        let mut entry = self.live.get_mut(id)?;
        if entry.last_seen.elapsed() > self.idle {
            // Expired: drop the borrow before removing, or the map deadlocks
            // on its own shard.
            drop(entry);
            self.live.remove(id);
            return None;
        }
        entry.last_seen = Instant::now();
        Some(entry.identity.clone())
    }

    pub fn close(&self, id: &str) {
        self.live.remove(id);
    }

    /// Forget every session past its idle window.
    pub fn sweep(&self) {
        self.live.retain(|_, e| e.last_seen.elapsed() <= self.idle);
    }

    pub fn count(&self) -> usize {
        self.live.len()
    }

    /// How long an unused session survives. Worth exposing because a caller
    /// holding a bearer needs to be told what it is holding: a token whose
    /// lifetime nobody stated is a token somebody caches forever.
    pub fn idle(&self) -> Duration {
        self.idle
    }
}

/// The session id this request carries, if any.
///
/// Two envelopes for one thing. A browser carries it in the cookie, which is
/// `HttpOnly` and sent automatically; a script carries it as a bearer, which it
/// had to put there on purpose. The deliberate one wins where both arrive: a
/// cookie is sent whether or not the caller meant it, so letting it outrank a
/// header would have an open browser tab quietly override what a script
/// actually asked for.
///
/// This is *not* the rule for an identity arriving next to a delegation token —
/// those are two authorisation models and such a request is refused rather than
/// resolved. These are two envelopes for the same session, so picking one is a
/// transport decision, not an authorisation one.
///
/// Hand-parsed rather than pulled in as a dependency: one cookie and one header,
/// read once per request, and the whole of the format we care about is
/// `name=value` pairs separated by `; `.
pub fn session_id(headers: &HeaderMap) -> Option<String> {
    bearer(headers).or_else(|| cookie_id(headers))
}

/// The session id offered as `Authorization: Bearer`, for a caller that has no
/// cookie jar and does not want one.
///
/// One ambiguity to know about rather than discover: `/api/data/*` reads the
/// same header as a *published endpoint's* token. Nothing is ambiguous today,
/// because that route is exempt from the sign-in gate and never asks this
/// question — but the day a single route accepts both, it has to tell them
/// apart explicitly rather than by trying one and then the other.
fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, value) = raw.split_once(' ')?;
    // RFC 7235 makes the scheme case-insensitive, and clients disagree about
    // which case they send it in.
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// The session id out of the cookie a browser sends.
fn cookie_id(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| name.trim() == COOKIE)
        .map(|(_, value)| value.trim().to_string())
}

/// Whether this request arrived over TLS, as far as it is possible to tell.
///
/// Flint terminates plain HTTP: in the deployment it is designed for, TLS ends
/// at an ingress and the hop to the sidecar is inside the pod. So the question
/// can only be answered by what the proxy says it did, and if nothing says
/// anything, the honest answer is no — marking a cookie `Secure` on a plain-HTTP
/// deployment makes the browser discard it, which locks everybody out.
pub fn is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        // A chain of proxies leaves a list; the first entry is the client's.
        .and_then(|v| v.split(',').next())
        .map(|proto| proto.trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// `Set-Cookie` for a session that has just started.
///
/// `HttpOnly` so no script can read it, `SameSite=Lax` so a link from elsewhere
/// still lands you signed in while a cross-site form post does not carry it, and
/// no `Max-Age` at all: a session cookie dies with the browser session, which is
/// the behaviour somebody signing into a database console expects.
pub fn set_cookie(id: &str, secure: bool) -> HeaderValue {
    let mut value = format!("{COOKIE}={id}; Path=/; HttpOnly; SameSite=Lax");
    if secure {
        value.push_str("; Secure");
    }
    // The id is a UUID and the rest is ours, so this cannot fail — but an
    // `expect` in a request path is a panic waiting for a surprise, and an
    // unusable cookie is better than a dead process.
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// `Set-Cookie` that removes the session cookie.
///
/// The same attributes it was set with, because a browser matches on those when
/// deciding which cookie is being replaced.
pub fn clear_cookie(secure: bool) -> HeaderValue {
    let mut value = format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    if secure {
        value.push_str("; Secure");
    }
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (name, value) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        h
    }

    #[test]
    fn a_session_resolves_to_the_identity_that_opened_it() {
        let sessions = Sessions::new(Duration::from_secs(60));
        let id = sessions.open(Identity::new("analyst", "hunter2"));
        let found = sessions.resolve(&id).expect("the session was just opened");
        assert_eq!(found.user(), "analyst");
        assert_eq!(found.password(), "hunter2");
    }

    #[test]
    fn an_unknown_id_resolves_to_nobody() {
        let sessions = Sessions::new(Duration::from_secs(60));
        assert!(sessions.resolve("not-a-session").is_none());
    }

    #[test]
    fn an_idle_session_expires_and_is_forgotten() {
        // Zero idle window: every session is already past it, which is the
        // expiry branch without a sleep in a test.
        let sessions = Sessions::new(Duration::ZERO);
        let id = sessions.open(Identity::new("analyst", "hunter2"));
        assert!(sessions.resolve(&id).is_none());
        // Resolving an expired session removes it rather than leaving it to be
        // swept later: it is dead either way, and holding a password after that
        // is holding it for nothing.
        assert_eq!(sessions.count(), 0);
    }

    #[test]
    fn signing_out_ends_the_session_immediately() {
        let sessions = Sessions::new(Duration::from_secs(60));
        let id = sessions.open(Identity::new("analyst", "hunter2"));
        sessions.close(&id);
        assert!(sessions.resolve(&id).is_none());
    }

    #[test]
    fn two_sessions_never_share_an_id() {
        let sessions = Sessions::new(Duration::from_secs(60));
        let a = sessions.open(Identity::new("a", ""));
        let b = sessions.open(Identity::new("b", ""));
        assert_ne!(a, b);
        assert_eq!(sessions.resolve(&a).unwrap().user(), "a");
        assert_eq!(sessions.resolve(&b).unwrap().user(), "b");
    }

    #[test]
    fn a_session_remembers_which_server_it_was_opened_against() {
        // The whole of unpinned mode rests on this: two people signed into one
        // Flint may be on two different ClickHouses, and nothing but the
        // session knows which.
        let sessions = Sessions::new(Duration::from_secs(60));
        let a = sessions.open(
            Identity::new("analyst", "")
                .at("http://one:8123")
                .cutting_dates_in("Europe/Paris"),
        );
        let b = sessions.open(Identity::new("analyst", "").at("http://two:8123"));
        assert_eq!(
            sessions.resolve(&a).unwrap().endpoint(),
            Some("http://one:8123")
        );
        assert_eq!(sessions.resolve(&a).unwrap().timezone(), "Europe/Paris");
        assert_eq!(
            sessions.resolve(&b).unwrap().endpoint(),
            Some("http://two:8123")
        );
        // Unread rather than guessed: an answer from `two` says nothing about
        // its zone.
        assert_eq!(sessions.resolve(&b).unwrap().timezone(), "");
    }

    #[test]
    fn credentials_with_no_endpoint_mean_the_one_in_the_manifest() {
        // The pinned path, which is every deployment that existed before this
        // field did.
        assert_eq!(Identity::new("analyst", "").endpoint(), None);
    }

    #[test]
    fn the_password_is_not_in_the_debug_output() {
        // The whole point of the manual `Debug`: a `tracing` call added while
        // chasing something else must not put a database password in a log.
        let printed = format!("{:?}", Identity::new("analyst", "hunter2"));
        assert!(!printed.contains("hunter2"), "{printed}");
        assert!(printed.contains("analyst"), "{printed}");
    }

    #[test]
    fn the_cookie_is_read_out_of_a_crowded_header() {
        let h = headers(&[("cookie", "theme=dark; flint_session=abc123; other=x")]);
        assert_eq!(session_id(&h).as_deref(), Some("abc123"));
    }

    #[test]
    fn a_bearer_carries_the_session_for_a_caller_with_no_cookie_jar() {
        let h = headers(&[("authorization", "Bearer abc123")]);
        assert_eq!(session_id(&h).as_deref(), Some("abc123"));
        // The scheme is case-insensitive, and clients send every variant of it.
        assert_eq!(
            session_id(&headers(&[("authorization", "bearer abc123")])).as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn a_deliberate_bearer_outranks_an_ambient_cookie() {
        // The browser sends the cookie whether or not the caller meant it; the
        // header is there because somebody put it there.
        let h = headers(&[
            ("cookie", "flint_session=from-the-jar"),
            ("authorization", "Bearer from-the-header"),
        ]);
        assert_eq!(session_id(&h).as_deref(), Some("from-the-header"));
    }

    #[test]
    fn a_live_cookie_does_not_rescue_a_dead_bearer() {
        // The consequence of the rule above, and the one worth stating: a
        // bearer that is well formed and no longer a session is *still* the
        // claim this request made, so it is refused rather than quietly served
        // under whatever the browser happened to be carrying. Falling back here
        // would mean a request that presented one credential gets answered as
        // another, which is the whole failure this ordering exists to prevent.
        let h = headers(&[
            ("cookie", "flint_session=still-good"),
            ("authorization", "Bearer expired-hours-ago"),
        ]);
        assert_eq!(session_id(&h).as_deref(), Some("expired-hours-ago"));
    }

    #[test]
    fn an_authorization_header_that_is_not_a_bearer_is_not_a_session() {
        // Basic credentials are somebody else's business, and an empty bearer
        // is not a claim to anything — both fall through to the cookie.
        for value in ["Basic YWJjOjEyMw==", "Bearer", "Bearer   "] {
            let h = headers(&[
                ("cookie", "flint_session=from-the-jar"),
                ("authorization", value),
            ]);
            assert_eq!(session_id(&h).as_deref(), Some("from-the-jar"), "{value}");
        }
        assert!(session_id(&headers(&[("authorization", "Bearer ")])).is_none());
    }

    #[test]
    fn no_cookie_and_a_foreign_cookie_both_mean_no_session() {
        assert!(session_id(&HeaderMap::new()).is_none());
        assert!(session_id(&headers(&[("cookie", "theme=dark")])).is_none());
        // A cookie whose name merely ends the same way is not ours.
        assert!(session_id(&headers(&[("cookie", "not_flint_session=abc")])).is_none());
    }

    #[test]
    fn tls_is_believed_only_when_the_proxy_says_so() {
        assert!(is_secure(&headers(&[("x-forwarded-proto", "https")])));
        assert!(is_secure(&headers(&[("x-forwarded-proto", "https, http")])));
        assert!(!is_secure(&headers(&[("x-forwarded-proto", "http")])));
        // Nothing said: plain HTTP, because guessing `Secure` here would have
        // the browser throw the cookie away and nobody could sign in.
        assert!(!is_secure(&HeaderMap::new()));
    }

    #[test]
    fn the_cookie_is_locked_down() {
        let value = set_cookie("abc123", false);
        let value = value.to_str().unwrap();
        assert!(value.contains("flint_session=abc123"));
        assert!(value.contains("HttpOnly"));
        assert!(value.contains("SameSite=Lax"));
        assert!(!value.contains("Secure"));
        // No Max-Age: it dies with the browser session.
        assert!(!value.contains("Max-Age"));

        assert!(set_cookie("abc123", true)
            .to_str()
            .unwrap()
            .contains("; Secure"));
    }

    #[test]
    fn clearing_the_cookie_expires_it_now() {
        let value = clear_cookie(false);
        let value = value.to_str().unwrap();
        assert!(value.contains("flint_session=;"));
        assert!(value.contains("Max-Age=0"));
    }
}
