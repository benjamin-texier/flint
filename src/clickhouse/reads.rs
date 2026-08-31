//! Which tables a statement reads, according to the server rather than to us.
//!
//! Flint has to place an alert in one of the two spaces, and the rule is that it
//! follows what the alert *queries* rather than who wrote it. Answering that
//! means knowing the tables a piece of SQL touches — which is a question with a
//! bad answer and a good one. The bad answer is a regex over the text: aliases,
//! CTEs, an unqualified name whose database comes from somewhere else, and
//! `FROM` inside a string literal all make it wrong in ways nobody notices until
//! an alert is filed under the wrong heading.
//!
//! The good answer is to ask ClickHouse, which already resolves all of that to
//! run the query at all. `EXPLAIN QUERY TREE` analyses without executing and
//! names every table it resolved. Four edges were measured before this was
//! relied on:
//!
//! - **A join names both.** `FROM system.query_log q, system.parts p` gives two
//!   `table_name` lines.
//! - **A CTE is not skipped.** `WITH x AS (SELECT * FROM system.one) SELECT …
//!   FROM x` puts `system.one` deeper in the tree, under the subquery — so the
//!   whole tree is read, not only its first level.
//! - **An unqualified name is resolved**, against the database the statement is
//!   sent with. `FROM query_log` with `database=system` comes back
//!   `system.query_log`, which is exactly the resolution a text scan cannot do.
//! - **A table function names no table.** `numbers(10)` and
//!   `merge('system', …)` appear as `table_function_name` with no `table_name`
//!   at all — and `merge` really does read tables. So a statement built on one
//!   is *unplaceable* rather than empty, and says so.
//!
//! One thing it does not do, measured and worth knowing: `EXPLAIN QUERY TREE`
//! answers for a user with no privilege on the table. It resolves names; it does
//! not check grants. That makes it safe to run on somebody's behalf here, and
//! useless as an access check anywhere else.

use serde::{Deserialize, Serialize};

use super::Client;
use crate::error::Result;

/// What a statement was found to read.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Reads {
    /// Tables, fully qualified as the server resolved them.
    pub tables: Vec<String>,
    /// Table functions, which name no table and may read many.
    pub functions: Vec<String>,
}

/// Which space a statement belongs to, by what it reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Space {
    /// It reads somebody's data. The subject is a table an analyst owns.
    Data,
    /// It reads the server about itself, and nothing else.
    Infra,
    /// It could not be placed: a table function reads what its arguments say,
    /// and the tree does not say. Guessing here files an alert under a heading
    /// its author will not think to look in.
    Unplaceable,
}

/// The databases that describe the server rather than hold anybody's data.
///
/// `INFORMATION_SCHEMA` is here in both spellings because ClickHouse ships it
/// twice, and a rule that matches one of them files half the alerts wrongly.
fn about_the_server(table: &str) -> bool {
    let database = table.split('.').next().unwrap_or("");
    database.eq_ignore_ascii_case("system") || database.eq_ignore_ascii_case("information_schema")
}

impl Reads {
    /// Which space this belongs in.
    ///
    /// A statement that touches a user table is Data even where it also reads
    /// `system.*` — the user table is the subject and the system table is
    /// context, and the person who wants to know about `orders` works in Data.
    /// The reverse is not symmetrical: an alert reading only `system.*` has no
    /// subject in Data at all.
    pub fn space(&self) -> Space {
        if self.tables.iter().any(|t| !about_the_server(t)) {
            return Space::Data;
        }
        if !self.tables.is_empty() {
            return Space::Infra;
        }
        // Nothing named. A table function may read half the server, and a
        // constant query reads nothing — neither can be placed by what it reads,
        // which is the only rule there is.
        Space::Unplaceable
    }
}

/// Pull every table and table function out of a query tree.
///
/// The tree is indented text rather than anything structured, so this reads the
/// two labels it needs at any depth. Depth is the point: a CTE puts its table
/// several levels down, and stopping at the first level would call an alert
/// built on one "reads nothing".
pub fn from_tree(tree: &str) -> Reads {
    let mut reads = Reads::default();
    for line in tree.lines() {
        if let Some(name) = field(line, "table_name: ") {
            if !reads.tables.contains(&name) {
                reads.tables.push(name);
            }
        }
        if let Some(name) = field(line, "table_function_name: ") {
            if !reads.functions.contains(&name) {
                reads.functions.push(name);
            }
        }
    }
    reads.tables.sort();
    reads.functions.sort();
    reads
}

/// One labelled value out of a tree line, up to the comma that ends it.
fn field(line: &str, label: &str) -> Option<String> {
    let at = line.find(label)? + label.len();
    let rest = &line[at..];
    let end = rest.find(',').unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[derive(Deserialize)]
struct TreeLine {
    explain: String,
}

/// Ask the server what a statement reads, without running it.
pub async fn reads(ch: &Client, sql: &str, database: &str) -> Result<Reads> {
    // Sent with the statement's own database so an unqualified name resolves the
    // way it will when the alert actually runs. Anything else answers a question
    // about a different query.
    let opts = super::QueryOptions {
        database: (!database.is_empty()).then(|| database.to_string()),
        ..super::QueryOptions::internal()
    };
    let lines: Vec<TreeLine> = ch
        .rows_with(&format!("EXPLAIN QUERY TREE {sql}"), opts)
        .await?;
    let tree = lines
        .into_iter()
        .map(|l| l.explain)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(from_tree(&tree))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the server actually returned, kept verbatim: a CTE puts its
    /// table three levels below the query that uses it.
    const CTE_TREE: &str = "QUERY id: 0
  JOIN TREE
    QUERY id: 3, alias: __table1, is_subquery: 1, is_cte: 1, cte_name: x
      JOIN TREE
        TABLE id: 6, alias: __table2, table_name: system.one";

    #[test]
    fn finds_a_table_however_deep_the_tree_puts_it() {
        // A first-level read would call this "reads nothing" and file the alert
        // as unplaceable.
        assert_eq!(from_tree(CTE_TREE).tables, vec!["system.one".to_string()]);
    }

    #[test]
    fn a_join_names_every_table_once() {
        let tree = "  TABLE id: 3, alias: __table1, table_name: system.parts
  TABLE id: 4, alias: __table2, table_name: system.query_log
  TABLE id: 5, alias: __table3, table_name: system.parts";
        assert_eq!(
            from_tree(tree).tables,
            vec!["system.parts".to_string(), "system.query_log".to_string()]
        );
    }

    #[test]
    fn a_table_function_names_no_table() {
        // `merge('system', '^query_log$')` really does read tables, and the tree
        // does not say which. Calling that "reads nothing" would place it in
        // Data by default, under a heading its author will not look in.
        let tree = "  TABLE_FUNCTION id: 3, table_function_name: merge";
        let reads = from_tree(tree);
        assert!(reads.tables.is_empty());
        assert_eq!(reads.functions, vec!["merge".to_string()]);
        assert_eq!(reads.space(), Space::Unplaceable);
    }

    #[test]
    fn system_alone_is_the_servers_own_space() {
        let reads = Reads {
            tables: vec!["system.parts".into(), "system.replicas".into()],
            functions: Vec::new(),
        };
        assert_eq!(reads.space(), Space::Infra);
    }

    #[test]
    fn a_user_table_decides_it_even_beside_a_system_one() {
        // The user table is the subject and `system.parts` is context. Somebody
        // who wants to know about `orders` works in Data, whatever else the
        // query joins for background.
        let reads = Reads {
            tables: vec!["analytics.orders".into(), "system.parts".into()],
            functions: Vec::new(),
        };
        assert_eq!(reads.space(), Space::Data);
    }

    #[test]
    fn information_schema_is_about_the_server_in_both_spellings() {
        // ClickHouse ships it twice, and a rule that matches one spelling files
        // half of these wrongly.
        for name in ["INFORMATION_SCHEMA.tables", "information_schema.tables"] {
            let reads = Reads {
                tables: vec![name.into()],
                functions: Vec::new(),
            };
            assert_eq!(reads.space(), Space::Infra, "{name}");
        }
    }
}
