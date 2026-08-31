//! Give me this file now.
//!
//! The published endpoints cover the API case — a machine that calls an address
//! on a schedule. They do not cover the other half of what people want from a
//! table, which is a file on their disk, once, right now.
//!
//! Two decisions shape everything here:
//!
//! **ClickHouse does the formatting.** `CSVWithNames`, `JSONEachRow`, `Parquet`
//! — the server already writes all three, correctly, including the quoting and
//! the type mapping Flint would otherwise reimplement and get subtly wrong for
//! `Decimal`, `Nullable(Date32)` and the rest. Flint names one of them as the
//! request's `default_format` and moves the bytes that come back. There is no
//! serialiser in this file and there must never be one.
//!
//! **A download is never capped.** Every other read in Flint is a page, and a
//! page says how much it left out. A file cannot: nothing in a Parquet footer
//! says "and there were four million more". So the cap comes off, and the
//! honesty moves to *before* the click — the caller is told the row count they
//! are about to ask for. A truncated download that looked whole is the exact
//! failure this codebase drops figures rather than dashing them to avoid.

use serde::{Deserialize, Serialize};

/// What comes back, and what the file is called.
///
/// Three and only three. Every one of them is something a person opens in
/// another tool without thinking: a spreadsheet, a line-reading script, a
/// dataframe. A format nobody can open is a download nobody wanted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Jsonl,
    Parquet,
}

impl Format {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "csv" => Ok(Format::Csv),
            "jsonl" | "ndjson" | "jsoneachrow" => Ok(Format::Jsonl),
            "parquet" => Ok(Format::Parquet),
            other => Err(format!(
                "`{other}` is not a format this exports — ask for csv, jsonl or parquet"
            )),
        }
    }

    /// ClickHouse's own name for it.
    ///
    /// `CSVWithNames` rather than `CSV`: a headerless CSV is a file whose
    /// columns you have to count, and every tool that opens one expects the
    /// header row.
    pub fn clickhouse(self) -> &'static str {
        match self {
            Format::Csv => "CSVWithNames",
            Format::Jsonl => "JSONEachRow",
            Format::Parquet => "Parquet",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Jsonl => "jsonl",
            Format::Parquet => "parquet",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Format::Csv => "text/csv; charset=utf-8",
            // Not `application/json`: a browser told that will try to render a
            // file that is not one document but many, and show a parse error
            // for a download that is perfectly good.
            Format::Jsonl => "application/x-ndjson",
            Format::Parquet => PARQUET_TYPE,
        }
    }
}

/// Named rather than written twice: the router excludes exactly this type from
/// gzip, and a copy of the string in two files is a copy that drifts.
pub const PARQUET_TYPE: &str = "application/vnd.apache.parquet";

/// A filename that survives being saved on any of the three desktops.
///
/// Everything outside the safe set becomes a dash rather than being dropped,
/// because dropping turns `sales/2026` and `sales2026` into the same file and
/// the person with both loses one of them. Runs of dashes collapse so a name
/// full of punctuation does not come out as a row of hyphens.
///
/// Letters are kept whatever alphabet they are in. Restricting to ASCII would
/// hand a French user `donn-es.csv` for a table they called `données`, and the
/// three desktops have all handled UTF-8 filenames for two decades — what
/// actually needs escaping is the *header*, which `disposition` does. What is
/// dashed here is what a path or a shell would misread: separators, quotes,
/// control characters, and everything else that is not a letter or a digit.
pub fn filename(stem: &str, format: Format) -> String {
    let mut out = String::with_capacity(stem.len() + 8);
    let mut last_dash = false;
    for c in stem.chars() {
        if (c.is_alphanumeric() && !c.is_control()) || c == '_' || c == '.' {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.');
    // A name that was entirely punctuation would otherwise become `.csv`, which
    // is a hidden file on two of the three desktops and nameless on the third.
    let stem = if trimmed.is_empty() {
        "export"
    } else {
        trimmed
    };
    format!("{stem}.{}", format.extension())
}

/// `attachment; filename="…"`, with a UTF-8 form for the names ASCII cannot say.
///
/// Both forms, and in this order, because the rule is a browser-compatibility
/// rule rather than a taste one: RFC 6266 says a client that understands
/// `filename*` must prefer it, and one that does not falls back to `filename`.
/// Sending only the ASCII form loses every accent; sending only the extended
/// one loses the name entirely on anything old.
pub fn disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii() && c != '"' { c } else { '-' })
        .collect();
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent(name)
    )
}

fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_format_is_one_of_three_and_says_so() {
        assert_eq!(Format::parse("csv").unwrap(), Format::Csv);
        assert_eq!(Format::parse("  PARQUET ").unwrap(), Format::Parquet);
        // The names the rest of Flint already uses for the same thing.
        assert_eq!(Format::parse("ndjson").unwrap(), Format::Jsonl);
        let refused = Format::parse("xlsx").unwrap_err();
        assert!(refused.contains("csv, jsonl or parquet"), "{refused}");
    }

    #[test]
    fn a_csv_carries_its_header() {
        // A headerless CSV is a file whose columns you have to count.
        assert_eq!(Format::Csv.clickhouse(), "CSVWithNames");
    }

    #[test]
    fn jsonl_is_not_served_as_json() {
        // A browser told `application/json` tries to render many documents as
        // one and shows a parse error for a perfectly good download.
        assert!(!Format::Jsonl.content_type().contains("application/json"));
    }

    #[test]
    fn a_filename_survives_being_saved() {
        assert_eq!(filename("events", Format::Csv), "events.csv");
        assert_eq!(
            filename("analytics.events", Format::Parquet),
            "analytics.events.parquet"
        );
        // Separators become dashes rather than vanishing: dropping them turns
        // two different tables into one filename.
        assert_eq!(filename("sales/2026", Format::Csv), "sales-2026.csv");
        assert_ne!(
            filename("sales/2026", Format::Csv),
            filename("sales2026", Format::Csv)
        );
        // A run of punctuation is one dash, not five.
        assert_eq!(filename("a  ///  b", Format::Jsonl), "a-b.jsonl");
        // And a name that is all punctuation still has a name.
        assert_eq!(filename("///", Format::Csv), "export.csv");
        assert_eq!(filename("", Format::Csv), "export.csv");
    }

    #[test]
    fn a_name_keeps_its_letters_whatever_alphabet_they_are_in() {
        // `donn-es.csv` for a table called `données` is a small rudeness that
        // an ASCII-only rule commits on every non-English deployment.
        assert_eq!(filename("données", Format::Csv), "données.csv");
        assert_eq!(filename("продажи", Format::Csv), "продажи.csv");
        // What is actually dangerous is still dashed.
        assert_eq!(filename("a/b", Format::Csv), "a-b.csv");
        assert_eq!(filename("a\u{7}b", Format::Csv), "a-b.csv");
    }

    #[test]
    fn a_disposition_says_the_name_twice() {
        let said = disposition(&filename("ventes été", Format::Csv));
        // The ASCII fallback for anything old, and the exact name for anything
        // that understands RFC 6266 — which is what carries the accents now
        // that the filename keeps them.
        assert!(said.contains(r#"filename="ventes--t-.csv""#), "{said}");
        assert!(
            said.contains("filename*=UTF-8''ventes-%C3%A9t%C3%A9.csv"),
            "{said}"
        );
    }

    #[test]
    fn a_quote_in_a_name_cannot_end_the_header() {
        // The one that matters: an unescaped quote would let a table name close
        // the header early and write whatever came after it.
        let said = disposition(r#"a"b.csv"#);
        assert!(!said.contains(r#"a"b"#), "{said}");
        assert!(said.contains(r#"filename="a-b.csv""#), "{said}");
    }
}
