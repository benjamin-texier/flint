//! Answers, kept for a few seconds.
//!
//! A published endpoint is usually a *dashboard tile*, which means the same
//! question arrives from forty browsers within the same minute and ClickHouse
//! answers it forty times. A short cache turns that into one query, and the
//! interesting thing about it is not the saving — it is that a caller can now
//! be told exactly how stale the figure in front of them is allowed to be.
//!
//! Three decisions worth stating, because each has an obvious wrong answer.
//!
//! **It is off by default.** A TTL of zero caches nothing, and that is what
//! every endpoint published before this module existed has. A figure nobody
//! asked to be stale should not become stale because a default said so.
//!
//! **The key is everything that changes the answer** — the address, the
//! revision, the format, and every bound parameter and shape control. Not the
//! token and not the key: two callers of the same endpoint with the same
//! question get the same answer, because a published endpoint runs as the
//! endpoint and not as whoever is asking. If that ever stops being true, the
//! caller's identity has to enter this key, and the compiler will not tell
//! you.
//!
//! **An entry is served whole or not at all.** No revalidation, no serving
//! stale while refreshing. A cache that can hand back an entry it knows to be
//! expired is a cache whose TTL is a suggestion, and the whole point of the
//! number is that somebody can put it in a sentence to a caller.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How many answers to hold. A cap rather than a memory budget: the entries
/// are pages of a published endpoint, which are already bounded by `max_rows`,
/// and a count is a number an operator can reason about.
const CAPACITY: usize = 512;

/// One answer, as it went out.
#[derive(Clone)]
pub struct Entry {
    pub body: Vec<u8>,
    /// The headers computed for it — paging, the cursor, the link. Recomputing
    /// them would mean recomputing the page, which is the thing being avoided.
    pub headers: Vec<(String, String)>,
    pub content_type: &'static str,
    stored: Instant,
    ttl: Duration,
    slug: String,
}

impl Entry {
    pub fn age(&self) -> Duration {
        self.stored.elapsed()
    }

    fn fresh(&self) -> bool {
        self.stored.elapsed() < self.ttl
    }
}

/// The store. One per process, and deliberately not shared between them: two
/// Flints behind a load balancer each keep their own, which means a caller can
/// see an answer up to one TTL older than another caller. That is a real
/// consequence and it is the reason the TTL is stated on the page rather than
/// hidden — at 60 seconds nobody minds, and at an hour somebody would.
#[derive(Default)]
pub struct Cache {
    entries: Mutex<HashMap<String, Entry>>,
}

impl Cache {
    pub fn new() -> Cache {
        Cache::default()
    }

    /// The key for one question. Every input that can change the bytes.
    pub fn key(
        slug: &str,
        revision: u32,
        format: &str,
        bound: &[(String, String)],
        shape: &[(String, String)],
    ) -> String {
        // Sorted, because a query string is a bag and `?a=1&b=2` must not be a
        // different question from `?b=2&a=1`. `\u{1}` separates: it cannot
        // occur in a URL-decoded parameter that ClickHouse would accept, so no
        // pair of different inputs can collide by running into each other.
        let mut parts: Vec<String> = bound
            .iter()
            .chain(shape.iter())
            .map(|(k, v)| format!("{k}\u{1}{v}"))
            .collect();
        parts.sort();
        format!(
            "{slug}\u{1}{revision}\u{1}{format}\u{1}{}",
            parts.join("\u{2}")
        )
    }

    /// A fresh answer, if there is one. Expired entries are dropped on the way
    /// past rather than left for a sweep: this is the only code that looks at
    /// them, so it is the only code that can.
    pub fn get(&self, key: &str) -> Option<Entry> {
        let mut entries = self.entries.lock().ok()?;
        match entries.get(key) {
            Some(entry) if entry.fresh() => Some(entry.clone()),
            Some(_) => {
                entries.remove(key);
                None
            }
            None => None,
        }
    }

    pub fn put(
        &self,
        key: String,
        slug: &str,
        ttl: Duration,
        body: Vec<u8>,
        headers: Vec<(String, String)>,
        content_type: &'static str,
    ) {
        if ttl.is_zero() {
            return;
        }
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.len() >= CAPACITY && !entries.contains_key(&key) {
            // Evict what is closest to expiring anyway. Not an LRU: these
            // entries all die of old age within seconds, so "nearly dead" is a
            // better thing to throw away than "least recently asked for", and
            // it needs no bookkeeping on the read path.
            let oldest = entries
                .iter()
                .max_by_key(|(_, e)| e.stored.elapsed())
                .map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key,
            Entry {
                body,
                headers,
                content_type,
                stored: Instant::now(),
                ttl,
                slug: slug.to_string(),
            },
        );
    }

    /// The age of the oldest answer this endpoint could still hand back.
    ///
    /// The sentence on the page is "the oldest row a caller can receive right
    /// now", and this is the only place that can answer it: the TTL says what
    /// is *permitted*, and this says what is actually being held. On a quiet
    /// endpoint they are very different numbers.
    pub fn oldest(&self, slug: &str) -> Option<Duration> {
        let entries = self.entries.lock().ok()?;
        entries
            .values()
            .filter(|e| e.slug == slug && e.fresh())
            .map(Entry::age)
            .max()
    }

    /// How many answers are held for one address, for the same panel.
    pub fn held(&self, slug: &str) -> usize {
        self.entries
            .lock()
            .map(|e| e.values().filter(|e| e.slug == slug && e.fresh()).count())
            .unwrap_or(0)
    }

    /// Forget everything for one address.
    ///
    /// Called when a revision is edited, goes live or is retired. Without it,
    /// the seconds after a change are served out of a cache filled by the
    /// version before it — which is the one moment somebody is definitely
    /// watching, and the one moment a stale answer reads as a broken deploy.
    pub fn forget(&self, slug: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, e| e.slug != slug);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(raw: &[(&str, &str)]) -> Vec<(String, String)> {
        raw.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    fn store(cache: &Cache, key: &str, slug: &str, ttl: Duration) {
        cache.put(
            key.to_string(),
            slug,
            ttl,
            b"{}".to_vec(),
            Vec::new(),
            "application/json",
        );
    }

    #[test]
    fn the_same_question_asked_two_ways_round_is_one_key() {
        let a = Cache::key("d", 4, "json", &pairs(&[("from", "1"), ("to", "2")]), &[]);
        let b = Cache::key("d", 4, "json", &pairs(&[("to", "2"), ("from", "1")]), &[]);
        assert_eq!(a, b);
    }

    #[test]
    fn a_different_revision_or_format_is_a_different_answer() {
        let base = Cache::key("d", 4, "json", &pairs(&[("from", "1")]), &[]);
        assert_ne!(
            base,
            Cache::key("d", 5, "json", &pairs(&[("from", "1")]), &[])
        );
        assert_ne!(
            base,
            Cache::key("d", 4, "csv", &pairs(&[("from", "1")]), &[])
        );
        assert_ne!(
            base,
            Cache::key("e", 4, "json", &pairs(&[("from", "1")]), &[])
        );
    }

    #[test]
    fn values_that_would_run_into_each_other_do_not_collide() {
        // `a=1, b=2` and `a=1b=2` are different questions, and a naive join
        // would spell them the same way.
        let a = Cache::key("d", 1, "json", &pairs(&[("a", "1"), ("b", "2")]), &[]);
        let b = Cache::key("d", 1, "json", &pairs(&[("a", "1b=2")]), &[]);
        assert_ne!(a, b);
    }

    #[test]
    fn a_ttl_of_zero_stores_nothing_at_all() {
        let cache = Cache::new();
        store(&cache, "k", "d", Duration::ZERO);
        assert!(cache.get("k").is_none());
        assert_eq!(cache.held("d"), 0);
    }

    #[test]
    fn an_expired_entry_is_never_handed_back() {
        let cache = Cache::new();
        store(&cache, "k", "d", Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(cache.get("k").is_none());
        // …and looking is what removed it.
        assert_eq!(cache.held("d"), 0);
    }

    #[test]
    fn a_fresh_entry_comes_back_whole() {
        let cache = Cache::new();
        cache.put(
            "k".into(),
            "d",
            Duration::from_secs(60),
            b"rows".to_vec(),
            vec![("x-flint-returned".into(), "1".into())],
            "text/csv",
        );
        let got = cache.get("k").expect("a fresh entry");
        assert_eq!(got.body, b"rows");
        assert_eq!(got.content_type, "text/csv");
        assert_eq!(got.headers.len(), 1);
    }

    #[test]
    fn the_oldest_held_answer_is_what_the_panel_reports() {
        let cache = Cache::new();
        store(&cache, "a", "d", Duration::from_secs(60));
        std::thread::sleep(Duration::from_millis(8));
        store(&cache, "b", "d", Duration::from_secs(60));
        let oldest = cache.oldest("d").expect("something is held");
        assert!(oldest >= Duration::from_millis(8), "{oldest:?}");
        assert_eq!(cache.held("d"), 2);
        // Another endpoint's entries are not this one's.
        assert!(cache.oldest("other").is_none());
    }

    #[test]
    fn forgetting_an_address_leaves_its_neighbours_alone() {
        let cache = Cache::new();
        store(&cache, "a", "d", Duration::from_secs(60));
        store(&cache, "b", "other", Duration::from_secs(60));
        cache.forget("d");
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some());
    }

    #[test]
    fn the_store_stays_within_its_cap() {
        let cache = Cache::new();
        for i in 0..(CAPACITY + 40) {
            store(&cache, &format!("k{i}"), "d", Duration::from_secs(60));
        }
        assert!(cache.held("d") <= CAPACITY, "{}", cache.held("d"));
    }
}
