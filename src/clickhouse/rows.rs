//! Writing a row somebody typed.
//!
//! The whole design of this module is one sentence: **Flint never formats a
//! value into SQL.** Every field the person filled in travels as a ClickHouse
//! query parameter declared with the column's own type — `{price:Decimal(9,2)}`
//! — so the server parses it, against the type it is about to store it in, and
//! a value cannot become syntax however it is typed. That is the same binding
//! the rest of the product reads with; this is the first place it writes with
//! it.
//!
//! Four things were asked of a real server before any of this was written, and
//! each one settled a decision:
//!
//! - **Parameters work in `INSERT … VALUES`.** They are not a `SELECT`-only
//!   facility. `Nullable(String)` and `Enum8('ok'=1,'bad'=2)` both bind, which
//!   is what makes an enum a list in the form rather than free text.
//! - **A column left out of the list takes its `DEFAULT`.** So "leave this to
//!   the table" is the absence of a field rather than a magic value in one —
//!   there is no string a person could type that means *default*, and inventing
//!   one would collide with the string they meant to store.
//! - **An empty box is an empty string, not a null.** Binding `''` stores a
//!   zero-length string and `IS NULL` is false. The two are different answers,
//!   so a nullable column gets an explicit way to say null and a blank box
//!   never quietly becomes one.
//! - **A parameter may be named after its column, and then the server's own
//!   error names the field somebody filled in**: *Value oops cannot be parsed
//!   as UInt32 for query parameter 'id'*. That is worth more than any message
//!   Flint could write, so the name is used wherever it is a legal one — see
//!   `param_name` for the case where it is not.
//!
//! What is *not* bound is the column name, because an identifier is not a
//! literal and no binding exists for one. So a name is checked against the
//! table's own columns, read from the server at the moment of writing, and a
//! name that is not in that list never reaches a statement.

use serde::Deserialize;

use super::{Client, QueryOptions};
use crate::error::{Error, Result};

/// A column, as somebody writing a row needs to see it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    /// `""`, `DEFAULT`, `MATERIALIZED`, `ALIAS` — the server's own word.
    pub default_kind: String,
    pub default_expression: String,
    pub comment: String,
    pub position: u64,
}

impl Column {
    /// Whether a value may be written into this column at all.
    ///
    /// Measured rather than assumed, because the two refusals are different
    /// enough that neither error would have told a reader what the other means:
    /// naming a `MATERIALIZED` column in an insert answers
    /// `Code: 44 … Cannot insert column c, because it is MATERIALIZED column`,
    /// and naming an `ALIAS` one answers `Code: 16 … No such column d in table`
    /// — as though it were not there, when it is there and is computed.
    pub fn writable(&self) -> bool {
        !matches!(self.default_kind.as_str(), "MATERIALIZED" | "ALIAS")
    }
}

/// Every column of a table, in the order the table declares them.
///
/// Read at the moment of writing rather than taken from the caller: the column
/// names and the declared types both go into the statement — one as an
/// identifier, one inside a parameter declaration — and neither is a literal
/// that could be bound. The server is the only authority on both.
pub async fn columns(ch: &Client, database: &str, table: &str) -> Result<Vec<Column>> {
    #[derive(Deserialize)]
    struct Row {
        name: String,
        #[serde(rename = "type")]
        type_name: String,
        default_kind: String,
        default_expression: String,
        comment: String,
        position: u64,
    }
    let rows: Vec<Row> = ch
        .rows_with(
            "SELECT name, type, default_kind, default_expression, comment, position \
             FROM system.columns \
             WHERE database = {db:String} AND table = {tbl:String} \
             ORDER BY position",
            QueryOptions {
                params: vec![
                    ("db".into(), database.to_string()),
                    ("tbl".into(), table.to_string()),
                ],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    if rows.is_empty() {
        // Or it exists and this user may not see it: `system.columns` is
        // filtered by grants and cannot tell the two apart.
        return Err(Error::NotFound(format!(
            "there is no `{database}.{table}` that this user can see"
        )));
    }
    Ok(rows
        .into_iter()
        .map(|r| Column {
            name: r.name,
            type_name: r.type_name,
            default_kind: r.default_kind,
            default_expression: r.default_expression,
            comment: r.comment,
            position: r.position,
        })
        .collect())
}

/// What the caller says goes in a column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Given {
    /// Text, to be parsed by the server against the column's declared type.
    Value(String),
    /// SQL `NULL`. Written as the bare keyword rather than bound, because it is
    /// Flint's own token and not the caller's text — and because the recorded
    /// statement then says `NULL` where a reader expects to see it.
    Null,
}

/// A statement and the values to bind to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Insert {
    pub sql: String,
    pub params: Vec<(String, String)>,
}

/// The name to bind a column's value under.
///
/// The column's own name wherever ClickHouse will accept it as a parameter,
/// because the server's parse errors quote the parameter name and that turns
/// *"cannot be parsed as UInt32 for query parameter 'p3'"* into one naming the
/// field the person was typing in.
///
/// The fallback is not hypothetical: a name with a space in it is a
/// `Code: 62 … Cannot parse expression of type UInt32 here: {my col:UInt32}`,
/// a syntax error rather than a bad value, and it would take down a statement
/// that had nothing wrong with the data. Positional names are ugly and always
/// work, so an unusual column gets one and the route puts the real name back
/// into the message.
pub fn param_name(column: &str, index: usize) -> String {
    let legal = !column.is_empty()
        && column.len() <= 64
        && column
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && column
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if legal {
        column.to_string()
    } else {
        format!("p{index}")
    }
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// The `INSERT`, with one binding per value that is not a null.
///
/// Columns not in `fields` are left out of the statement entirely, which is
/// what makes the table's own `DEFAULT` apply — verified against a server:
/// a `note String DEFAULT 'none'` omitted from the column list came back as
/// `none`.
pub fn insert(database: &str, table: &str, fields: &[(&Column, Given)]) -> Insert {
    let mut names = Vec::with_capacity(fields.len());
    let mut slots = Vec::with_capacity(fields.len());
    let mut params = Vec::new();
    for (index, (column, given)) in fields.iter().enumerate() {
        names.push(ident(&column.name));
        match given {
            Given::Null => slots.push("NULL".to_string()),
            Given::Value(text) => {
                let param = param_name(&column.name, index);
                slots.push(format!("{{{param}:{}}}", column.type_name));
                params.push((param, text.clone()));
            }
        }
    }
    Insert {
        sql: format!(
            "INSERT INTO {}.{} ({}) VALUES ({})",
            ident(database),
            ident(table),
            names.join(", "),
            slots.join(", "),
        ),
        params,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, type_name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: type_name.into(),
            default_kind: String::new(),
            default_expression: String::new(),
            comment: String::new(),
            position: 1,
        }
    }

    fn kind(name: &str, default_kind: &str) -> Column {
        Column {
            default_kind: default_kind.into(),
            ..col(name, "UInt32")
        }
    }

    #[test]
    fn a_computed_column_cannot_be_written() {
        assert!(kind("a", "").writable());
        assert!(kind("b", "DEFAULT").writable());
        assert!(!kind("c", "MATERIALIZED").writable());
        assert!(!kind("d", "ALIAS").writable());
    }

    #[test]
    fn every_value_travels_as_a_binding_of_the_columns_own_type() {
        let id = col("id", "UInt32");
        let name = col("name", "Nullable(String)");
        let out = insert(
            "analytics",
            "events",
            &[
                (&id, Given::Value("7".into())),
                (&name, Given::Value("o'brien".into())),
            ],
        );
        assert_eq!(
            out.sql,
            "INSERT INTO `analytics`.`events` (`id`, `name`) \
             VALUES ({id:UInt32}, {name:Nullable(String)})"
        );
        // The apostrophe never reaches the statement, which is the point.
        assert!(!out.sql.contains("o'brien"));
        assert_eq!(
            out.params,
            vec![
                ("id".to_string(), "7".to_string()),
                ("name".to_string(), "o'brien".to_string())
            ]
        );
    }

    #[test]
    fn a_null_is_a_keyword_and_binds_nothing() {
        // Flint's own token rather than the caller's text, so the statement a
        // reader is shown says NULL where they expect to see it.
        let name = col("name", "Nullable(String)");
        let out = insert("d", "t", &[(&name, Given::Null)]);
        assert_eq!(out.sql, "INSERT INTO `d`.`t` (`name`) VALUES (NULL)");
        assert!(out.params.is_empty());
    }

    #[test]
    fn a_column_left_out_is_how_a_default_applies() {
        // There is no string that means "default", because any such string is
        // one somebody might have meant to store.
        let id = col("id", "UInt32");
        let out = insert("d", "t", &[(&id, Given::Value("1".into()))]);
        assert!(!out.sql.contains("note"));
    }

    #[test]
    fn an_identifier_is_quoted_and_its_backquotes_doubled() {
        let odd = col("we`ird", "String");
        let out = insert("d", "t", &[(&odd, Given::Value("x".into()))]);
        assert!(out.sql.contains("`we``ird`"));
    }

    #[test]
    fn a_parameter_is_named_after_its_column_where_that_is_legal() {
        // So the server's own parse error names the field somebody typed in.
        assert_eq!(param_name("id", 0), "id");
        assert_eq!(param_name("_private", 3), "_private");
        assert_eq!(param_name("col2", 1), "col2");
    }

    #[test]
    fn an_unusual_column_name_falls_back_to_a_position() {
        // A space makes it a syntax error rather than a bad value, which would
        // take down a statement with nothing wrong in its data.
        assert_eq!(param_name("my col", 2), "p2");
        assert_eq!(param_name("2fast", 0), "p0");
        assert_eq!(param_name("", 1), "p1");
        assert_eq!(param_name("naïve", 4), "p4");
        assert_eq!(param_name(&"x".repeat(65), 5), "p5");
    }

    #[test]
    fn a_fallback_name_still_declares_the_columns_type() {
        let odd = col("my col", "DateTime64(3)");
        let out = insert("d", "t", &[(&odd, Given::Value("2026-08-31".into()))]);
        assert!(out.sql.contains("{p0:DateTime64(3)}"));
        assert_eq!(
            out.params,
            vec![("p0".to_string(), "2026-08-31".to_string())]
        );
    }
}
