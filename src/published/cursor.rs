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

// ── base64url, which is 30 lines and not a dependency ───────────────────

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded, and with the URL alphabet: this lands in a query string, where
/// `+`, `/` and `=` all mean something else.
fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3F) as usize] as char);
        }
    }
    out
}

fn unbase64url(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() || text.len() > 8192 {
        return None;
    }
    let mut bits = 0u32;
    let mut held = 0u8;
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    for ch in text.bytes() {
        // Padding is not emitted, but a caller may have round-tripped this
        // through something that adds it back.
        if ch == b'=' {
            break;
        }
        let value = ALPHABET.iter().position(|c| *c == ch)? as u32;
        bits = (bits << 6) | value;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push(((bits >> held) & 0xFF) as u8);
        }
    }
    Some(out)
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
}
