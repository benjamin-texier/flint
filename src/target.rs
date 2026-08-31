//! Where a browser is allowed to point Flint.
//!
//! Normally the server Flint talks to is named in the manifest and nobody else
//! gets a say. Unpinned — `FLINT_CLICKHOUSE_URL` unset — the *browser* names it
//! at sign-in, which is a different thing entirely: an address arriving from
//! outside, that this process will then dial. That is the shape of an SSRF, so
//! the address is taken apart here before it is used, and the rules are in one
//! file rather than spread over the sign-in handler.
//!
//! What this cannot do, said plainly so nobody relies on it: the host is vetted
//! as *written*, not as resolved. A name under someone else's control can point
//! at anything, including the address this file refuses literally below, and
//! Flint would follow it — closing that means resolving the name here and
//! dialling the address we resolved, which reqwest does not let us do without
//! its own connector. So this is a fence, not a boundary. The boundary is
//! `FLINT_TARGETS`, which is why an unpinned Flint reachable by anyone should
//! set it.

use url::{Host, Url};

/// An endpoint, normalised and vetted, or the reason it was refused.
///
/// The message is shown to whoever typed the address, so it says what to type
/// instead rather than naming the rule that fired.
pub fn vet(raw: &str, allowed: &[String]) -> Result<String, String> {
    let endpoint = normalise(raw)?;

    // Parsed before the emptiness test, not after: `FLINT_TARGETS=` reaches
    // clap as one empty entry, and a list that is non-empty and yields no rules
    // would refuse every address there is — locking out the deployment that
    // meant to constrain nothing.
    let rules: Vec<Rule> = allowed
        .iter()
        .filter_map(|entry| Rule::parse(entry))
        .collect();

    // Empty means "anywhere". Deliberate: the point of unpinned mode is
    // `docker run flint` with nothing set, and a required allow-list would take
    // that away. The boot log says the fence is down.
    if rules.is_empty() {
        return Ok(endpoint);
    }

    let url = Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let matched = rules.iter().any(|rule| rule.matches(&url));
    if matched {
        return Ok(endpoint);
    }
    // The permitted hosts are named back to whoever asked, and that is a decision
    // rather than an oversight: this message is read before anybody has signed
    // in, so it discloses the addresses in `FLINT_TARGETS` to anyone who can
    // reach this port. The alternative is somebody who cannot see the manifest
    // guessing at what is allowed, which is a support conversation every time —
    // and the hosts named here are, by construction, ones the operator chose to
    // make reachable *through this Flint*. Nothing is given away that using it
    // would not reveal.
    Err(format!(
        "this Flint may only connect to {} — `{}` is not one of them. \
         FLINT_TARGETS is what decides.",
        allowed.join(", "),
        host_port(&url),
    ))
}

/// The endpoint as Flint will send it, or the reason it is not one.
///
/// Separate from the allow-list check because it is the half that runs even
/// where anything is allowed: a string that is not an address Flint can dial is
/// refused for its own reasons, and saying which is the difference between
/// "fix your typo" and "ask your operator".
pub fn normalise(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("name the ClickHouse HTTP endpoint, e.g. http://localhost:8123".into());
    }

    // `clickhouse:8123` is what people type, and it parses as a *scheme* called
    // `clickhouse` — so the prefix is decided by looking for the two schemes we
    // accept rather than for a colon.
    let lower = raw.to_ascii_lowercase();
    let with_scheme = if lower.starts_with("http://") || lower.starts_with("https://") {
        raw.to_string()
    } else if let Some(rest) = lower.split_once("://") {
        // Something else entirely — `file://`, `gopher://`, and the one that
        // matters, `unix://`. Named rather than silently prefixed, because
        // prefixing would turn a refusal into a confusing 502.
        return Err(format!(
            "`{}` is not a scheme Flint speaks — ClickHouse's HTTP interface is `http` or `https`",
            rest.0
        ));
    } else {
        format!("http://{raw}")
    };

    let mut url = Url::parse(&with_scheme)
        .map_err(|_| format!("`{raw}` is not an address — expected something like host:8123"))?;

    // Credentials in the URL are refused rather than used. They belong in the
    // form: a password in an address is a password in every log line that ever
    // prints the address, and Flint prints this one at sign-in.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(
            "leave the user and password out of the address — they go in the fields beside it"
                .into(),
        );
    }

    let host = url.host().ok_or_else(|| format!("`{raw}` names no host"))?;
    if url.host_str().unwrap_or_default().is_empty() {
        return Err(format!("`{raw}` names no host"));
    }
    if link_local(&host) {
        return Err(
            "169.254.0.0/16 and fe80::/10 are the link-local ranges, and nothing there is a \
             ClickHouse — Flint will not dial them"
                .into(),
        );
    }

    // Our own settings ride in the query string and the fragment never leaves
    // the browser, so both are dropped rather than carried into a request where
    // they would collide with `param_*` or be sent as noise.
    url.set_query(None);
    url.set_fragment(None);

    // `Url` normalises a bare host to a `/` path; a proxy that serves
    // ClickHouse under a prefix keeps its prefix, minus the trailing slash that
    // would double up when reqwest joins.
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Whether the host is a link-local address, in either family.
///
/// The range that matters is 169.254.0.0/16, because 169.254.169.254 is where
/// every cloud keeps the credentials of the machine Flint is running on, and
/// reaching it *at all* is the exploit.
///
/// Checked as a parsed **address** rather than as the text somebody typed, and
/// that is not a refinement — the text check this replaces had a hole. The
/// address has a dozen legal spellings: decimal `2852039166`, hex
/// `0xa9.0xfe.0xa9.0xfe`, octal, a trailing dot. `Url` normalises every one of
/// those to the same IPv4 literal, so `starts_with("169.254.")` did catch them.
/// What it did not catch is `[::ffff:169.254.169.254]` — the same address wearing
/// IPv6's clothes, which `Url` keeps as `[::ffff:a9fe:a9fe]` and which Linux
/// routes to the IPv4 address without complaint. That one got through.
///
/// A *name* that resolves into either range still does, and always will while the
/// host is vetted before it is resolved. See the module note: this is the fence,
/// `FLINT_TARGETS` is the boundary.
fn link_local(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(v4) => v4.is_link_local(),
        Host::Ipv6(v6) => {
            // `to_ipv4` covers both the mapped form (`::ffff:a.b.c.d`) and the
            // deprecated compatible one (`::a.b.c.d`); both route.
            v6.to_ipv4().map(|v4| v4.is_link_local()).unwrap_or(false)
                // fe80::/10, the same idea in IPv6's own numbering. A prefix test
                // because `Ipv6Addr::is_unicast_link_local` is not stable, and
                // one line of masking beats a nightly feature.
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
        // A name. Not resolved here, deliberately — see above.
        Host::Domain(_) => false,
    }
}

/// One `FLINT_TARGETS` entry.
///
/// `host`, `host:port` or `scheme://host:port`. The parts that are absent do
/// not constrain: `clickhouse` permits it on any port over either scheme, which
/// is what somebody writing one word means. Anything narrower has to be written
/// out, because the alternative is an entry that silently permits less than it
/// looks like and a sign-in that fails for a reason nobody can see.
struct Rule {
    scheme: Option<String>,
    host: String,
    port: Option<u16>,
}

impl Rule {
    fn parse(entry: &str) -> Option<Self> {
        let entry = entry.trim().to_ascii_lowercase();
        if entry.is_empty() {
            return None;
        }
        let (scheme, rest) = match entry.split_once("://") {
            Some((scheme, rest)) => (Some(scheme.to_string()), rest.to_string()),
            None => (None, entry),
        };
        let rest = rest.trim_end_matches('/');
        // An IPv6 literal is bracketed, and its colons are not port separators.
        let (host, port) = if let Some(end) = rest.strip_prefix('[').and_then(|r| r.find(']')) {
            let (bracketed, after) = rest.split_at(end + 2);
            (
                bracketed.to_string(),
                after.strip_prefix(':').and_then(|p| p.parse().ok()),
            )
        } else {
            match rest.rsplit_once(':') {
                Some((host, port)) => (host.to_string(), port.parse().ok()),
                None => (rest.to_string(), None),
            }
        };
        (!host.is_empty()).then_some(Rule { scheme, host, port })
    }

    fn matches(&self, url: &Url) -> bool {
        if let Some(scheme) = &self.scheme {
            if scheme != url.scheme() {
                return false;
            }
        }
        if let Some(port) = self.port {
            if Some(port) != url.port_or_known_default() {
                return false;
            }
        }
        url.host_str()
            .map(|host| host.eq_ignore_ascii_case(&self.host))
            .unwrap_or(false)
    }
}

/// How an endpoint is named back to whoever typed it: host and port, without
/// the scheme, because that is the part they got wrong.
fn host_port(url: &Url) -> String {
    match (url.host_str(), url.port_or_known_default()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|e| e.to_string()).collect()
    }

    #[test]
    fn a_bare_host_and_port_becomes_an_http_url() {
        // What people actually type, and the case that would parse as a scheme
        // called `clickhouse` if the prefix were decided by looking for a colon.
        assert_eq!(
            normalise("clickhouse:8123").unwrap(),
            "http://clickhouse:8123"
        );
        assert_eq!(
            normalise("  localhost:8123 ").unwrap(),
            "http://localhost:8123"
        );
        assert_eq!(normalise("localhost").unwrap(), "http://localhost");
    }

    #[test]
    fn a_written_scheme_is_kept_whatever_its_case() {
        assert_eq!(
            normalise("https://ch.example.com:8443").unwrap(),
            "https://ch.example.com:8443"
        );
        assert_eq!(
            normalise("HTTP://Localhost:8123").unwrap(),
            "http://localhost:8123"
        );
    }

    #[test]
    fn a_trailing_slash_query_and_fragment_are_dropped() {
        // The query would collide with the settings Flint sends; the trailing
        // slash would double up on the way out.
        assert_eq!(normalise("http://ch:8123/").unwrap(), "http://ch:8123");
        assert_eq!(
            normalise("http://ch:8123/?database=x#frag").unwrap(),
            "http://ch:8123"
        );
        // A prefix a proxy serves ClickHouse under survives, which is the
        // reason the path is not simply thrown away.
        assert_eq!(
            normalise("http://gateway/clickhouse/").unwrap(),
            "http://gateway/clickhouse"
        );
    }

    #[test]
    fn another_scheme_is_named_rather_than_prefixed() {
        for raw in [
            "file:///etc/passwd",
            "unix:///var/run/ch.sock",
            "gopher://x",
        ] {
            let err = normalise(raw).expect_err(raw);
            assert!(err.contains("not a scheme Flint speaks"), "{raw}: {err}");
        }
    }

    #[test]
    fn credentials_in_the_address_are_refused_not_used() {
        // Because the next thing that happens to this string is a log line.
        let err = normalise("http://default:hunter2@ch:8123").expect_err("credentials");
        assert!(err.contains("leave the user and password out"), "{err}");
        assert!(normalise("http://default@ch:8123").is_err());
    }

    #[test]
    fn the_link_local_range_is_refused_however_it_is_spelled() {
        for raw in [
            "169.254.169.254",
            "http://169.254.169.254/latest/meta-data",
            "169.254.1.1",
            // The same address in every spelling a URL parser accepts. These
            // pass because `Url` normalises them to the IPv4 literal — asserted
            // rather than assumed, because the check depends on it.
            "http://2852039166",
            "http://0xa9.0xfe.0xa9.0xfe",
            "http://0251.0376.0251.0376",
            "http://169.254.169.254.",
            // And the one that got through a check on the text: the same address
            // in IPv6's clothes, which `Url` keeps as `[::ffff:a9fe:a9fe]` and
            // Linux routes to 169.254.169.254 without complaint.
            "http://[::ffff:169.254.169.254]:80",
            "http://[::ffff:a9fe:a9fe]",
            "http://[::169.254.169.254]",
            // fe80::/10, the same range in the other family.
            "http://[fe80::1]:8123",
            "http://[febf:ffff::1]",
        ] {
            let err = normalise(raw).expect_err(raw);
            assert!(err.contains("link-local"), "{raw}: {err}");
        }
    }

    #[test]
    fn an_ordinary_address_is_not_mistaken_for_a_link_local_one() {
        // The masking is one line, and one line is where an off-by-one lives.
        // `fec0::` is past fe80::/10, and 169.253/169.255 are past the /16.
        for raw in [
            "http://[::1]:8123",
            "http://[fec0::1]:8123",
            "http://[2001:db8::1]:8123",
            "http://169.253.1.1:8123",
            "http://169.255.1.1:8123",
            "http://127.0.0.1:8123",
        ] {
            assert!(normalise(raw).is_ok(), "{raw} was refused");
        }
    }

    #[test]
    fn nothing_typed_says_what_to_type() {
        let err = normalise("   ").expect_err("empty");
        assert!(err.contains("http://localhost:8123"), "{err}");
    }

    #[test]
    fn an_empty_allow_list_permits_anything_that_normalises() {
        assert_eq!(
            vet("ch.example.com:8123", &[]).unwrap(),
            "http://ch.example.com:8123"
        );
        // And still refuses what normalising refuses: the fence being down is
        // not the same as there being no fence.
        assert!(vet("169.254.169.254", &[]).is_err());
    }

    #[test]
    fn a_list_of_nothing_constrains_nothing() {
        // `FLINT_TARGETS=` in a `.env` arrives as one empty entry. Read as a
        // rule it matches no host, and every sign-in would be refused by an
        // allow-list nobody meant to write.
        for entries in [vec![""], vec!["", "  "], vec![" ", ""]] {
            let rules = allowed(&entries);
            assert!(vet("clickhouse:8123", &rules).is_ok(), "{entries:?}");
        }
        // A blank beside a real entry is dropped, and the real one still bites.
        let rules = allowed(&["", "clickhouse:8123"]);
        assert!(vet("clickhouse:8123", &rules).is_ok());
        assert!(vet("elsewhere:8123", &rules).is_err());
    }

    #[test]
    fn one_word_permits_that_host_on_any_port_and_either_scheme() {
        let rules = allowed(&["clickhouse"]);
        assert!(vet("clickhouse:8123", &rules).is_ok());
        assert!(vet("https://clickhouse:8443", &rules).is_ok());
        assert!(vet("clickhouse", &rules).is_ok());
        assert!(vet("elsewhere:8123", &rules).is_err());
    }

    #[test]
    fn a_port_and_a_scheme_narrow_it() {
        let rules = allowed(&["clickhouse:8123"]);
        assert!(vet("clickhouse:8123", &rules).is_ok());
        assert!(vet("clickhouse:9000", &rules).is_err());

        let rules = allowed(&["https://ch.example.com:8443"]);
        assert!(vet("https://ch.example.com:8443", &rules).is_ok());
        // Same host and port, plain HTTP: refused, which is the point of
        // writing the scheme.
        assert!(vet("http://ch.example.com:8443", &rules).is_err());
    }

    #[test]
    fn a_default_port_matches_the_scheme_that_implies_it() {
        // `https://host` is port 443 whether or not anybody wrote it.
        let rules = allowed(&["ch.example.com:443"]);
        assert!(vet("https://ch.example.com", &rules).is_ok());
        assert!(vet("http://ch.example.com", &rules).is_err());
    }

    #[test]
    fn an_ipv6_entry_keeps_its_colons() {
        let rules = allowed(&["[::1]:8123"]);
        assert!(vet("http://[::1]:8123", &rules).is_ok());
        assert!(vet("http://[::1]:9000", &rules).is_err());
    }

    #[test]
    fn a_refusal_names_the_variable_that_decided_it() {
        // Whoever typed the address cannot see the manifest, so the message has
        // to say both what is permitted and who to ask.
        let err = vet("elsewhere:8123", &allowed(&["clickhouse:8123"])).expect_err("refused");
        assert!(err.contains("elsewhere:8123"), "{err}");
        assert!(err.contains("clickhouse:8123"), "{err}");
        assert!(err.contains("FLINT_TARGETS"), "{err}");
    }

    #[test]
    fn the_host_is_matched_without_regard_to_case() {
        let rules = allowed(&["CH.Example.COM:8123"]);
        assert!(vet("ch.example.com:8123", &rules).is_ok());
    }
}
