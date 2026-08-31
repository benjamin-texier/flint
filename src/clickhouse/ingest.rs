//! Loading a file into a table.
//!
//! The feature that gets a browser tab used instead of `clickhouse-client`,
//! and the one whose whole promise is *before*: the schema the file turns out
//! to have, how it lines up with the table's, and a page of parsed rows, all
//! shown before a single row is written.
//!
//! ## Inference with no filesystem
//!
//! The roadmap said `DESCRIBE file()`, and that is not available to Flint:
//! `file()` reads the *server's* `user_files_path`, which Flint cannot write to
//! and should not want to. The mechanism that works instead is the `format()`
//! table function, which takes the data inline —
//! `DESCRIBE format(CSVWithNames, {sample:String})` infers the schema and
//! `SELECT * FROM format(…)` parses the rows, both with nothing touching a
//! disk anywhere.
//!
//! **A String parameter stops at the first newline.** Measured before it was
//! designed around: a sample sent raw comes back as
//! `Value … cannot be parsed as String … only 9 of 28 bytes was parsed`. The
//! parameter is read with TSV escaping rules, so `\n` written as two
//! characters arrives as one — and a tab or a backslash inside a field
//! round-trips the same way. That is what `escape` is for, and it is why the
//! sample can be a parameter at all rather than being spliced into a
//! statement, which is a thing this codebase does not do with a caller's text.
//!
//! ## All of the file, or none of it
//!
//! The roadmap asked for "rows accepted and rejected counted separately", and
//! the second of those numbers does not exist. With
//! `input_format_allow_errors_num` set, a file of four rows with two bad ones
//! answered `read_rows: 2, written_rows: 2` — the server counts what it
//! accepted and says nothing whatever about what it turned away. Flint would
//! have to count the file's records itself to subtract, and counting records
//! in a CSV means parsing CSV, because a quoted field may hold a newline.
//!
//! So the import does not tolerate errors, and that is the safer answer as
//! well as the honest one: a partial load that silently dropped rows it cannot
//! count is the exact shape this codebase refuses everywhere else. A bad row
//! stops the whole file and the server names it.
//!
//! Which is only tolerable because of the second measurement: **a failed
//! import writes nothing.** A file with 200,000 good rows and one bad row at
//! the end left the table at zero. Flint does not take that on trust either —
//! it counts the table before and after, so "how many rows arrived" is read
//! off the table rather than off a summary.

use serde::Deserialize;

use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// The formats a file may be read as.
///
/// Text formats only, and Parquet's absence is a consequence rather than an
/// omission: the sample travels as a `String` parameter, and a `String` is
/// text. A binary file could be escaped into one, but the promise this feature
/// makes — *see the parsed rows before anything is written* — is the promise
/// that would break, and a Parquet import with no preview is a different
/// feature wearing this one's name.
pub const FORMATS: &[&str] = &["CSVWithNames", "CSV", "TSVWithNames", "TSV", "JSONEachRow"];

pub fn known_format(name: &str) -> bool {
    FORMATS.contains(&name)
}

/// A sample, escaped so it survives being a query parameter.
///
/// ClickHouse reads a `String` parameter with TSV escaping, so the four
/// characters that end a field or a row have to arrive as escapes. Verified
/// round-trip against a server: a tab and a backslash inside a CSV field came
/// back intact.
pub fn escape(sample: &str) -> String {
    let mut out = String::with_capacity(sample.len() + 16);
    for ch in sample.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out
}

/// Whatever whole lines fit in `bytes`, so the sample never ends mid-record.
///
/// A truncated last line is not a small problem: it is a parse error in the
/// preview for a file that is perfectly good, which would send somebody
/// looking for a fault in their data. The cut is at the last newline, and a
/// sample with no newline at all is taken whole — a one-line file is a
/// legitimate file.
pub fn whole_lines(sample: &str, bytes: usize) -> &str {
    if sample.len() <= bytes {
        return sample;
    }
    let mut cut = bytes;
    while cut > 0 && !sample.is_char_boundary(cut) {
        cut -= 1;
    }
    match sample[..cut].rfind('\n') {
        Some(at) => &sample[..=at],
        None => &sample[..cut],
    }
}

/// A column the file turned out to have.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct Inferred {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// What the file is, before anything is written.
#[derive(Debug, serde::Serialize)]
pub struct Inspection {
    pub columns: Vec<Inferred>,
    /// A page of the file, parsed by the server exactly as the import will
    /// parse it. Cells as text, because that is what a preview grid shows.
    pub rows: Vec<Vec<String>>,
}

/// Ask the server what this file holds.
pub async fn inspect(ch: &Client, format: &str, sample: &str, rows: u64) -> Result<Inspection> {
    if !known_format(format) {
        return Err(Error::BadRequest(format!(
            "`{format}` is not a format Flint reads a file as. It offers {}.",
            FORMATS.join(", ")
        )));
    }
    let escaped = escape(sample);

    // The format name is not a literal and cannot be bound, so it is checked
    // against the list above and never taken as written.
    let described: Vec<Inferred> = ch
        .rows_with(
            &format!("DESCRIBE format({format}, {{sample:String}})"),
            QueryOptions {
                params: vec![("sample".into(), escaped.clone())],
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;
    if described.is_empty() {
        return Err(Error::BadRequest(
            "the server read no columns out of this file. Check the format.".into(),
        ));
    }

    let selected = ch
        .table(
            &format!("SELECT * FROM format({format}, {{sample:String}}) LIMIT {rows}"),
            QueryOptions {
                params: vec![("sample".into(), escaped)],
                max_rows: Some(rows),
                ..Default::default()
            },
        )
        .await?;

    Ok(Inspection {
        columns: described,
        rows: selected
            .rows
            .into_iter()
            .map(|row| row.into_iter().map(cell).collect())
            .collect(),
    })
}

/// A cell as the preview shows it. `null` stays a word rather than becoming an
/// empty string: in a file about to be imported, "this field was absent" and
/// "this field was empty" are the two things a reader is checking for.
fn cell(value: serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "ᴺᵁᴸᴸ".to_string(),
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    }
}

/// How a file's columns line up with the table's.
///
/// A report and not a control. ClickHouse matches a `*WithNames` file to a
/// table by column name itself, and a headerless one by position, so a mapping
/// widget here would be Flint re-implementing something the server already
/// does — and doing it differently. What is worth saying is what will not
/// match, which the server would otherwise report as one error at import time.
#[derive(Debug, serde::Serialize)]
pub struct Mapping {
    /// File columns that land in a table column of the same name.
    pub matched: Vec<String>,
    /// File columns with nowhere to go. An error at import unless the format
    /// is headerless, where position decides and names are not consulted.
    pub unmatched: Vec<String>,
    /// Table columns the file says nothing about. Each takes its `DEFAULT`,
    /// which is the same rule the single-row form follows.
    pub defaulted: Vec<String>,
    /// Whether the format carries its own names at all.
    pub by_name: bool,
}

pub fn mapping(inferred: &[Inferred], table: &[super::rows::Column], format: &str) -> Mapping {
    let by_name = format.ends_with("WithNames") || format == "JSONEachRow";
    let writable: Vec<&str> = table
        .iter()
        .filter(|c| c.writable())
        .map(|c| c.name.as_str())
        .collect();
    let file: Vec<&str> = inferred.iter().map(|c| c.name.as_str()).collect();
    Mapping {
        matched: file
            .iter()
            .filter(|n| writable.contains(n))
            .map(|n| n.to_string())
            .collect(),
        unmatched: file
            .iter()
            .filter(|n| !writable.contains(n))
            .map(|n| n.to_string())
            .collect(),
        defaulted: writable
            .iter()
            .filter(|n| !file.contains(n))
            .map(|n| n.to_string())
            .collect(),
        by_name,
    }
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// The statement the rows are sent with.
pub fn insert_statement(database: &str, table: &str, format: &str) -> String {
    format!(
        "INSERT INTO {}.{} FORMAT {format}",
        ident(database),
        ident(table)
    )
}

/// How many rows the table holds, counted rather than estimated.
///
/// `system.parts` would be cheaper and would be wrong here: it lags a fresh
/// insert, and this figure is read immediately either side of one. The point
/// of taking it twice is to answer "how many rows arrived" off the table
/// itself rather than off a summary the server may not have sent.
pub async fn row_count(ch: &Client, database: &str, table: &str) -> Result<u64> {
    #[derive(Deserialize)]
    struct Row {
        n: u64,
    }
    let row: Option<Row> = ch
        .row_with(
            &format!(
                "SELECT count() AS n FROM {}.{}",
                ident(database),
                ident(table)
            ),
            QueryOptions {
                quote_64bit_integers: false,
                ..Default::default()
            },
        )
        .await?;
    Ok(row.map_or(0, |r| r.n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_characters_that_end_a_field_or_a_row_are_escaped() {
        // A String parameter is read with TSV rules, so a raw newline ends the
        // value nine bytes in — measured, and the reason this exists.
        assert_eq!(escape("a,b\n1,2\n"), "a,b\\n1,2\\n");
        assert_eq!(escape("x\ty"), "x\\ty");
        assert_eq!(escape("back\\slash"), "back\\\\slash");
        assert_eq!(escape("crlf\r\n"), "crlf\\r\\n");
        assert_eq!(escape("plain"), "plain");
    }

    #[test]
    fn a_sample_is_cut_at_a_line_and_never_inside_one() {
        // A half-written last line is a parse error in the preview for a file
        // that is perfectly good, which sends somebody hunting their own data.
        assert_eq!(whole_lines("one\ntwo\nthree\n", 6), "one\n");
        assert_eq!(whole_lines("one\ntwo\n", 100), "one\ntwo\n");
        // No newline anywhere: a one-line file is a file.
        assert_eq!(whole_lines("aaaaaaaaaa", 4), "aaaa");
    }

    #[test]
    fn the_cut_never_splits_a_character() {
        let s = "héllo\nwörld\n";
        // Byte 2 is inside the é; the cut walks back rather than panicking.
        assert!(whole_lines(s, 2).is_char_boundary(whole_lines(s, 2).len()));
    }

    #[test]
    fn only_the_formats_on_the_list_reach_a_statement() {
        assert!(known_format("CSVWithNames"));
        assert!(!known_format("Parquet"));
        // The format name goes into the statement unquoted, so this is the
        // check that keeps it from being anything else.
        assert!(!known_format("CSV) UNION ALL SELECT 1 --"));
    }

    fn col(name: &str, kind: &str) -> super::super::rows::Column {
        super::super::rows::Column {
            name: name.into(),
            type_name: "String".into(),
            default_kind: kind.into(),
            default_expression: String::new(),
            comment: String::new(),
            position: 1,
        }
    }

    #[test]
    fn the_mapping_says_what_will_not_land_and_what_the_table_fills_in() {
        let inferred = vec![
            Inferred {
                name: "id".into(),
                type_name: "Int64".into(),
            },
            Inferred {
                name: "extra".into(),
                type_name: "String".into(),
            },
        ];
        let table = vec![col("id", ""), col("note", "DEFAULT"), col("calc", "ALIAS")];
        let m = mapping(&inferred, &table, "CSVWithNames");
        assert_eq!(m.matched, vec!["id"]);
        assert_eq!(m.unmatched, vec!["extra"]);
        // `calc` is computed, so it was never a column the file could fill and
        // reporting it as defaulted would suggest a choice was made about it.
        assert_eq!(m.defaulted, vec!["note"]);
        assert!(m.by_name);
    }

    #[test]
    fn a_headerless_format_is_matched_by_position_and_says_so() {
        let m = mapping(&[], &[], "CSV");
        assert!(!m.by_name);
        assert!(mapping(&[], &[], "JSONEachRow").by_name);
    }
}
