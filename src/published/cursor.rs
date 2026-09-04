//! Where a caller got to, in a form that survives the rows moving under them.
//!
//! Offset paging has one flaw nothing can fix from the outside: it counts.
//! Between page one and page two, rows are inserted and merged, and page two
//! is `LIMIT n OFFSET n` over a *different* result — so a row shifts across the
//! boundary and is served twice, or shifts back and is never served at all. On
//! a table anyone is writing to, that is not an edge case; it is the normal
//! case, and it is silent.
//!
//! A cursor counts nothing. It carries the ordering values of the last row it
//! served, and the next page asks for the rows strictly after them. Whatever
//! happened in between, no row before that point comes back, and nothing after
//! it is skipped.
//!
//! It is opaque on purpose. Not to hide anything — it is base64 of a small JSON
//! object, and anyone who wants to read it can — but because a caller who takes
//! it apart will eventually depend on its shape, and then Flint cannot change
//! it. The one thing it does check is that the order it was made for is the
//! order it is being used with: a cursor from `?order=n.desc` replayed against
//! `?order=city` points at a row nobody asked about.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    /// The order this cursor was made for, rendered the way the query string
    /// writes it: `n.desc,city`.
    #[serde(rename = "o")]
    pub order: String,
    /// One value per ordering column, in that order, as text.
    #[serde(rename = "v")]
    pub values: Vec<String>,
}

pub fn encode(cursor: &Cursor) -> String {
    let json = serde_json::to_vec(cursor).unwrap_or_default();
    base64url(&json)
}

pub fn decode(raw: &str) -> Result<Cursor, String> {
    let bytes =
        unbase64url(raw).ok_or_else(|| "this cursor is not one Flint issued".to_string())?;
    let cursor: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| "this cursor is not one Flint issued".to_string())?;
    if cursor.order.is_empty() || cursor.values.is_empty() {
        return Err("this cursor names no order, so there is nowhere for it to point".into());
    }
    Ok(cursor)
}

// ── base64url ───────────────────────────────────────────────────────────

/// The URL alphabet, because this lands in a query string where `+`, `/` and
/// `=` all mean something else — and *indifferent* to padding, because Flint
/// emits none but a caller may have round-tripped the cursor through something
/// that adds it back.
///
/// This was thirty hand-written lines until it wasn't, and the thirty lines
/// were not wrong in the direction anyone worries about: they encoded
/// correctly. What they did was *decode* generously — trailing bits that no
/// encoder could have produced were shifted off and ignored, so a string that
/// is not base64 at all had a good chance of decoding to something, and the
/// only thing standing between that and a page of rows was whether the bytes
/// happened to parse as the JSON below. `base64` rejects them, which is the
/// half of the job worth taking a dependency for. It is already in the tree
/// through `reqwest`.
const ENGINE: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    base64::engine::GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
);

fn base64url(bytes: &[u8]) -> String {
    base64::Engine::encode(&ENGINE, bytes)
}

fn unbase64url(text: &str) -> Option<Vec<u8>> {
    // A cursor carries one row's ordering values. Anything of this size is not
    // one, and decoding it before finding that out is work done for whoever
    // sent it.
    if text.is_empty() || text.len() > 8192 {
        return None;
    }
    base64::Engine::decode(&ENGINE, text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips() {
        let cursor = Cursor {
            order: "n.desc,city".into(),
            values: vec!["498".into(), "Oslo Sør".into()],
        };
        let encoded = encode(&cursor);
        // It has to survive a query string without being escaped into
        // something else.
        assert!(
            encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "{encoded}"
        );
        assert_eq!(decode(&encoded).unwrap(), cursor);
    }

    #[test]
    fn every_length_of_input_round_trips() {
        // The three-byte chunking is where a hand-written base64 goes wrong,
        // and it goes wrong only on inputs whose length is not a multiple of 3.
        for n in 1..64 {
            let cursor = Cursor {
                order: "a".into(),
                values: vec!["x".repeat(n)],
            };
            assert_eq!(decode(&encode(&cursor)).unwrap(), cursor, "at {n}");
        }
    }

    #[test]
    fn something_that_is_not_a_cursor_is_refused_rather_than_guessed_at() {
        for bad in ["", "!!!!", "abcd", &"A".repeat(9000)] {
            assert!(decode(bad).is_err(), "{bad}");
        }
        // Well-formed base64 of something that is not a cursor.
        assert!(decode(&base64url(b"{\"o\":\"\",\"v\":[]}")).is_err());
    }

    #[test]
    fn bits_no_encoder_could_have_written_are_refused() {
        // `AA` is one byte with four zero bits left over, which is what
        // encoding one byte produces. `AB` is the same byte with those four
        // bits set — a string no encoder emits, and the shape of every
        // hand-typed or truncated cursor. Accepting it silently is how a
        // string that is not base64 gets a chance at being read as one.
        assert_eq!(unbase64url("AA"), Some(vec![0]));
        assert_eq!(unbase64url("AB"), None);
        // Padding is not emitted, but survives a round trip through something
        // that adds it.
        assert_eq!(unbase64url("AA=="), Some(vec![0]));
    }
}
