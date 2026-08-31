//! Running a `CREATE` somebody wrote.
//!
//! The one place in Flint where a whole statement arrives from outside rather
//! than being built here. Two things make that a much smaller problem than it
//! looks, and both were established by asking the server rather than by
//! reasoning:
//!
//! **ClickHouse's HTTP interface refuses multi-statements.** A body holding two
//! statements comes back as `Code: 62 … (Multi-statements are not allowed)` and
//! *neither* runs — verified with a `CREATE` followed by a `DROP` against a table
//! that was still there afterwards. So Flint does not have to find semicolons
//! outside string literals, which is a thing no amount of string matching does
//! correctly. A trailing semicolon on its own is accepted, as it should be.
//!
//! That is the opposite situation from `alter.rs`, where a *fragment* — a type, a
//! TTL expression — is spliced into a statement Flint builds. There the
//! semicolon check is the whole defence, because the server sees one statement
//! either way and it is Flint that decided what it said.
//!
//! **`create_table_query` round-trips.** What the server reports as a table's
//! definition, with the name changed, creates the same shape — verified by
//! copying a `ReplacingMergeTree` and reading back an empty table with the same
//! four columns. It carries no `UUID` clause unless
//! `show_table_uuid_in_table_create_query_if_not_nil` is on, which is off by
//! default, so the reported text is usable as written. That is what makes "start
//! from this table's own definition" an honest offer rather than a template.
//!
//! What is left is Flint's own policy, not the server's safety: this endpoint is
//! for creating, so it runs a `CREATE` and nothing else, and it refuses
//! `OR REPLACE` — which drops an existing table's data — for the same reason the
//! restore control refuses to write over something that is there.

/// The first bare word of a statement, upper-cased.
///
/// Comments and leading whitespace are stepped over, because `-- make a table`
/// before a `CREATE` is a statement somebody wrote and not an attack.
pub fn first_keyword(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after
                .split_once('\n')
                .map(|(_, r)| r)
                .unwrap_or("")
                .trim_start();
            continue;
        }
        if let Some(after) = rest.strip_prefix("/*") {
            rest = after
                .split_once("*/")
                .map(|(_, r)| r)
                .unwrap_or("")
                .trim_start();
            continue;
        }
        break;
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_uppercase()
}

/// Whether the statement asks to replace something that already exists.
///
/// Looked for in the first two words after `CREATE`, so a column called
/// `or_replace` or a comment mentioning it does not trip the check.
pub fn replaces(sql: &str) -> bool {
    let words: Vec<String> = sql
        .split_whitespace()
        .take(4)
        .map(|w| {
            w.trim_matches(|c: char| !c.is_ascii_alphabetic())
                .to_uppercase()
        })
        .collect();
    words.windows(2).any(|w| w[0] == "OR" && w[1] == "REPLACE")
}

/// Why Flint will not run this, or `None` when it will.
pub fn refusal(sql: &str) -> Option<String> {
    if sql.trim().is_empty() {
        return Some("there is no statement to run".to_string());
    }
    let word = first_keyword(sql);
    if word != "CREATE" {
        return Some(format!(
            "this runs a CREATE and nothing else, and that statement starts with {}. Dropping, \
             inserting and altering each have their own control, where the tier and the \
             confirmation belong to what they do.",
            if word.is_empty() {
                "something Flint cannot read as a keyword".to_string()
            } else {
                word
            }
        ));
    }
    if replaces(sql) {
        return Some(
            "OR REPLACE drops what is there before making the new one, and its rows go with it. \
             Drop the old table deliberately if that is what you mean — the same rule the restore \
             control follows."
                .to_string(),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_create_is_the_only_thing_it_runs() {
        assert!(refusal("CREATE TABLE t (x UInt8) ENGINE = Memory").is_none());
        assert!(refusal("create table t (x UInt8) ENGINE = Memory").is_none());

        let says = refusal("DROP TABLE t").expect("a drop is refused");
        assert!(says.contains("starts with DROP"));
        assert!(refusal("INSERT INTO t VALUES (1)").is_some());
        assert!(refusal("  ").is_some());
    }

    #[test]
    fn a_comment_before_the_keyword_is_not_an_attack() {
        // Somebody pasting their own DDL brings their own comments with it.
        assert!(refusal("-- the events table\nCREATE TABLE t (x UInt8) ENGINE = Memory").is_none());
        assert!(refusal("/* one */ /* two */ CREATE TABLE t (x UInt8) ENGINE = Memory").is_none());
        // And a comment hiding a drop is still a drop.
        assert!(refusal("-- CREATE\nDROP TABLE t").is_some());
    }

    #[test]
    fn or_replace_is_refused_because_it_deletes() {
        let says = refusal("CREATE OR REPLACE TABLE t (x UInt8) ENGINE = Memory")
            .expect("or replace is refused");
        assert!(says.contains("rows go with it"));
        assert!(refusal("CREATE  or   replace  TABLE t (x UInt8) ENGINE = Memory").is_some());
    }

    #[test]
    fn the_words_or_and_replace_elsewhere_are_left_alone() {
        // A column called `or_replace`, and a table called `replace`: neither is
        // an `OR REPLACE`, and refusing them would refuse valid DDL.
        assert!(refusal("CREATE TABLE t (or_replace UInt8) ENGINE = Memory").is_none());
        assert!(refusal("CREATE TABLE replaced (x UInt8) ENGINE = Memory").is_none());
    }

    #[test]
    fn nothing_here_looks_for_semicolons() {
        // Because the server does it properly: a body with two statements comes
        // back as `Code: 62 … (Multi-statements are not allowed)` and neither
        // runs. A trailing one is accepted, as it should be.
        assert!(refusal("CREATE TABLE t (x UInt8) ENGINE = Memory;").is_none());
        assert!(refusal("CREATE TABLE t (s String DEFAULT ';') ENGINE = Memory").is_none());
    }

    #[test]
    fn a_materialized_view_is_a_create_like_any_other() {
        assert!(refusal("CREATE MATERIALIZED VIEW mv TO t AS SELECT 1").is_none());
        assert!(refusal("CREATE DATABASE d").is_none());
        assert!(refusal("CREATE DICTIONARY d (id UInt64) PRIMARY KEY id").is_none());
    }
}
