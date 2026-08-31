//! Changing a table's columns and its TTL.
//!
//! Each operation carries two things the statement does not: whether it
//! **rewrites data**, and what "done" means when the job says so.
//!
//! **Which of these rewrite anything was measured, not assumed**, on a table of
//! 400,000 rows in two parts:
//!
//! | statement | mutation? |
//! |---|---|
//! | `ADD COLUMN x UInt8` | no |
//! | `ADD COLUMN x UInt32 DEFAULT id * 2` | no |
//! | `RENAME COLUMN a TO b` | **yes** |
//! | `MODIFY COLUMN s LowCardinality(String)` | **yes** |
//! | `DROP COLUMN x` | **yes** |
//! | `MODIFY TTL …` | **yes** |
//!
//! Adding a column costs nothing now — including with a default, which is
//! computed on read until a merge writes it down. Renaming one does rewrite,
//! which is the surprise in that table.
//!
//! **And "done" means done here.** `alter_sync` defaults to `1`, which waits for
//! the mutation to finish on *this* replica, so a job that reports done has
//! really applied: measured at 15 ms with `alter_sync = 0` and the mutation still
//! running, against 161 ms with the default and nothing left unfinished. Flint
//! keeps the default rather than raising it to `2`. Waiting for every replica
//! would make "done" mean more, and it would also hang against a replica that is
//! down — which the Keeper work has already shown is a state a cluster reaches —
//! and a job killed by a timeout while the change *did* apply locally is a worse
//! lie than a precise one. So the operations on a replicated table say what they
//! waited for.

use serde::{Deserialize, Deserializer, Serialize};

/// A `u64` that will also read the string a form sends.
fn lenient_u64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Either {
        Number(u64),
        Text(String),
    }
    match Either::deserialize(d)? {
        Either::Number(n) => Ok(n),
        Either::Text(s) => s.trim().parse().map_err(serde::de::Error::custom),
    }
}

/// One change to a table's shape.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Change {
    AddColumn {
        column: String,
        /// A ClickHouse type expression, checked by the server and not by Flint:
        /// the grammar is large, it changes between versions, and a validator
        /// here would refuse types this server understands.
        kind: String,
        /// `DEFAULT <expr>`, or empty. Its own field rather than part of the
        /// type so the statement cannot be smuggled through one.
        #[serde(default)]
        default_expr: String,
    },
    DropColumn {
        column: String,
    },
    ModifyColumn {
        column: String,
        kind: String,
        /// `DEFAULT <expr>`, or empty — and here it is not the convenience it is
        /// on `AddColumn`. ClickHouse refuses `MODIFY COLUMN c Bool` over a
        /// `Nullable(Bool)` outright: *"Cannot convert column from nullable type
        /// to non-nullable type. Please specify `DEFAULT` expression"*. Dropping
        /// the wrapper asks what a null becomes, and the server will not guess.
        ///
        /// So on this operation the clause is sometimes the difference between a
        /// statement that runs and one that cannot. It is still optional, and
        /// still its own field rather than something the caller may append to
        /// `kind` — a type is a type, and a second clause smuggled through it is
        /// how a statement ends up carrying something nobody reviewed.
        #[serde(default)]
        default_expr: String,
    },
    RenameColumn {
        column: String,
        to: String,
    },
    ModifyTtl {
        /// A TTL expression, again the server's to judge.
        expr: String,
    },
    RemoveTtl,
    /// Declare a skip index. **This does nothing to the data already there** —
    /// measured at zero bytes and no mutation — and the statement reports
    /// success either way.
    AddIndex {
        name: String,
        /// What it indexes.
        expression: String,
        /// The `TYPE` expression: `minmax`, `set(100)`, `bloom_filter(0.01)`.
        kind: String,
        /// How many index granules one entry covers.
        ///
        /// Read leniently because a form sends `"4"` and not `4`, and a body
        /// refused for the JSON type of a number the user typed correctly is a
        /// refusal nobody can act on. The alternative was making the browser
        /// know which of the fields it collects are numbers, which puts a
        /// schema in two places.
        #[serde(deserialize_with = "lenient_u64")]
        granularity: u64,
    },
    DropIndex {
        name: String,
    },
    /// Build it over the parts that already exist, which is the mutation the
    /// declaration was not.
    MaterializeIndex {
        name: String,
    },
    /// Declare a projection. Also inert until materialised.
    AddProjection {
        name: String,
        /// The `SELECT` inside the parentheses.
        query: String,
    },
    DropProjection {
        name: String,
    },
    MaterializeProjection {
        name: String,
    },
}

/// Whether an operation rewrites the data on disk.
///
/// Measured against a real table rather than reasoned from the statement. The
/// two that surprise: adding a column with a default rewrites nothing, and
/// renaming one does.
pub fn rewrites(change: &Change) -> bool {
    !matches!(
        change,
        Change::AddColumn { .. }
            | Change::AddIndex { .. }
            | Change::AddProjection { .. }
            | Change::DropIndex { .. }
            | Change::DropProjection { .. }
    )
}

/// Whether an operation can destroy data.
///
/// The line the tier enum draws. Dropping a column throws its values away, and a
/// TTL is a rule for deleting rows — applied to data already there, it deletes on
/// the next merge. Removing a TTL stops deletions and is therefore not on this
/// side of the line.
pub fn destroys(change: &Change) -> bool {
    matches!(change, Change::DropColumn { .. } | Change::ModifyTtl { .. })
}

pub fn kind(change: &Change) -> &'static str {
    match change {
        Change::AddColumn { .. } => "add-column",
        Change::DropColumn { .. } => "drop-column",
        Change::ModifyColumn { .. } => "modify-column",
        Change::RenameColumn { .. } => "rename-column",
        Change::ModifyTtl { .. } => "modify-ttl",
        Change::RemoveTtl => "remove-ttl",
        Change::AddIndex { .. } => "add-index",
        Change::DropIndex { .. } => "drop-index",
        Change::MaterializeIndex { .. } => "materialize-index",
        Change::AddProjection { .. } => "add-projection",
        Change::DropProjection { .. } => "drop-projection",
        Change::MaterializeProjection { .. } => "materialize-projection",
    }
}

/// The names this change puts into identifiers, for checking before quoting.
pub fn names(change: &Change) -> Vec<&str> {
    match change {
        Change::AddColumn { column, .. }
        | Change::DropColumn { column }
        | Change::ModifyColumn { column, .. } => vec![column.as_str()],
        Change::RenameColumn { column, to } => vec![column.as_str(), to.as_str()],
        Change::AddIndex { name, .. }
        | Change::DropIndex { name }
        | Change::MaterializeIndex { name }
        | Change::AddProjection { name, .. }
        | Change::DropProjection { name }
        | Change::MaterializeProjection { name } => vec![name.as_str()],
        Change::ModifyTtl { .. } | Change::RemoveTtl => Vec::new(),
    }
}

/// The type and expression fragments this change puts into the statement raw.
///
/// Returned so the route can refuse the ones that are empty or that carry a
/// semicolon — Flint does not parse ClickHouse's type grammar and will not
/// pretend to, but it will not pass a second statement through either.
pub fn fragments(change: &Change) -> Vec<&str> {
    match change {
        Change::AddColumn {
            kind, default_expr, ..
        } => {
            if default_expr.is_empty() {
                vec![kind.as_str()]
            } else {
                vec![kind.as_str(), default_expr.as_str()]
            }
        }
        Change::ModifyColumn {
            kind, default_expr, ..
        } => {
            if default_expr.is_empty() {
                vec![kind.as_str()]
            } else {
                vec![kind.as_str(), default_expr.as_str()]
            }
        }
        Change::ModifyTtl { expr } => vec![expr.as_str()],
        Change::AddIndex {
            expression, kind, ..
        } => vec![expression.as_str(), kind.as_str()],
        Change::AddProjection { query, .. } => vec![query.as_str()],
        _ => Vec::new(),
    }
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

pub fn statement(change: &Change, database: &str, table: &str) -> String {
    let target = format!("{}.{}", ident(database), ident(table));
    match change {
        Change::AddColumn {
            column,
            kind,
            default_expr,
        } => {
            let mut sql = format!("ALTER TABLE {target} ADD COLUMN {} {kind}", ident(column));
            if !default_expr.is_empty() {
                sql.push_str(&format!(" DEFAULT {default_expr}"));
            }
            sql
        }
        Change::DropColumn { column } => {
            format!("ALTER TABLE {target} DROP COLUMN {}", ident(column))
        }
        Change::ModifyColumn {
            column,
            kind,
            default_expr,
        } => {
            let mut sql = format!(
                "ALTER TABLE {target} MODIFY COLUMN {} {kind}",
                ident(column)
            );
            if !default_expr.is_empty() {
                sql.push_str(&format!(" DEFAULT {default_expr}"));
            }
            sql
        }
        Change::RenameColumn { column, to } => format!(
            "ALTER TABLE {target} RENAME COLUMN {} TO {}",
            ident(column),
            ident(to)
        ),
        Change::ModifyTtl { expr } => format!("ALTER TABLE {target} MODIFY TTL {expr}"),
        Change::RemoveTtl => format!("ALTER TABLE {target} REMOVE TTL"),
        Change::AddIndex {
            name,
            expression,
            kind,
            granularity,
        } => format!(
            "ALTER TABLE {target} ADD INDEX {} {expression} TYPE {kind} GRANULARITY {granularity}",
            ident(name)
        ),
        Change::DropIndex { name } => {
            format!("ALTER TABLE {target} DROP INDEX {}", ident(name))
        }
        Change::MaterializeIndex { name } => {
            format!("ALTER TABLE {target} MATERIALIZE INDEX {}", ident(name))
        }
        Change::AddProjection { name, query } => format!(
            "ALTER TABLE {target} ADD PROJECTION {} ({query})",
            ident(name)
        ),
        Change::DropProjection { name } => {
            format!("ALTER TABLE {target} DROP PROJECTION {}", ident(name))
        }
        Change::MaterializeProjection { name } => {
            format!(
                "ALTER TABLE {target} MATERIALIZE PROJECTION {}",
                ident(name)
            )
        }
    }
}

/// One line for the job list.
pub fn label(change: &Change, qualified: &str) -> String {
    match change {
        Change::AddColumn { column, kind, .. } => {
            format!("Add {column} {kind} to {qualified}")
        }
        Change::DropColumn { column } => format!("Drop column {column} of {qualified}"),
        Change::ModifyColumn { column, kind, .. } => {
            format!("Change {qualified}.{column} to {kind}")
        }
        Change::RenameColumn { column, to } => {
            format!("Rename {qualified}.{column} to {to}")
        }
        Change::ModifyTtl { expr } => format!("Set the TTL of {qualified} to {expr}"),
        Change::RemoveTtl => format!("Remove the TTL of {qualified}"),
        Change::AddIndex { name, kind, .. } => {
            format!("Declare index {name} {kind} on {qualified}")
        }
        Change::DropIndex { name } => format!("Drop index {name} of {qualified}"),
        Change::MaterializeIndex { name } => {
            format!("Build index {name} over the existing parts of {qualified}")
        }
        Change::AddProjection { name, .. } => {
            format!("Declare projection {name} on {qualified}")
        }
        Change::DropProjection { name } => format!("Drop projection {name} of {qualified}"),
        Change::MaterializeProjection { name } => {
            format!("Build projection {name} over the existing parts of {qualified}")
        }
    }
}

/// What it costs, said before it is pressed.
///
/// The figures are handed in, because "rewrites 400,000 rows in two parts" is a
/// sentence about this table and not about the operation.
pub fn costs(change: &Change, rows: u64, parts: u64, replicated: bool) -> String {
    let scale = if parts == 0 {
        "The table is empty, so there is nothing to rewrite.".to_string()
    } else {
        format!(
            "Rewrites {rows} rows across {parts} part{}.",
            if parts == 1 { "" } else { "s" }
        )
    };
    let waits = if replicated {
        " This waits for the rewrite on this replica only — the others apply it in their own \
         time, and the replication queue is where that shows."
    } else {
        " The job reports done when the rewrite has finished."
    };

    match change {
        // Measured: no mutation, with or without a default.
        Change::AddColumn { default_expr, .. } => {
            if default_expr.is_empty() {
                "Costs nothing now. The column exists in the metadata and reads as its type's \
                 default until something writes it."
                    .to_string()
            } else {
                "Costs nothing now. The default is computed on every read until a merge writes \
                 the column down, so this is cheap to add and not free to query."
                    .to_string()
            }
        }
        Change::DropColumn { column } => {
            format!("The values of {column} are gone and nothing brings them back. {scale}{waits}")
        }
        // The caveat is the second sentence, and it is only true while there is
        // no default: a conversion the server would refuse it *accepts* once a
        // DEFAULT says what an unconvertible value becomes. Dropping a Nullable
        // is exactly that case — the statement will not run without the clause,
        // and with it a null stops being an error and becomes a value.
        Change::ModifyColumn { default_expr, .. } => {
            if default_expr.is_empty() {
                format!(
                    "Every part is rewritten with the new type. A conversion the server cannot \
                     make it refuses outright rather than losing anything. {scale}{waits}"
                )
            } else {
                format!(
                    "Every part is rewritten with the new type. The default is what a value the \
                     server cannot convert becomes — a null dropping its Nullable, most often — \
                     so this converts quietly where it would otherwise refuse, and nothing brings \
                     the original back. {scale}{waits}"
                )
            }
        }
        // The surprise in the measurements: renaming is not metadata-only.
        Change::RenameColumn { .. } => {
            format!("Renaming rewrites the parts — it is not a metadata change. {scale}{waits}")
        }
        Change::ModifyTtl { .. } => format!(
            "A TTL is a rule for deleting rows, and it applies to the rows already here: \
             anything already past it goes on the next merge. {scale}{waits}"
        ),
        Change::RemoveTtl => {
            format!("Rows stop being deleted by age. Nothing already deleted comes back. {scale}")
        }
        // Measured: no mutation, and zero bytes afterwards. The statement
        // succeeds and the index does nothing, indefinitely, with no error
        // anywhere — which is the whole reason these two say it here.
        Change::AddIndex { .. } => "Costs nothing now, and does nothing now: the index goes into \
                                    the table's definition and the parts already here are left \
                                    alone. Every query ignores it until it is built."
            .to_string(),
        Change::AddProjection { .. } => "Costs nothing now, and answers nothing now: the \
                                         projection goes into the table's definition and is not \
                                         built over the data already there."
            .to_string(),
        Change::MaterializeIndex { .. } | Change::MaterializeProjection { .. } => format!(
            "Builds it over every part that already exists, which is the work the declaration \
             did not do. {scale}{waits}"
        ),
        Change::DropIndex { .. } | Change::DropProjection { .. } => {
            "Removes it and what it holds. The table's own rows are untouched — both are derived \
             from them and can be declared and built again."
                .to_string()
        }
    }
}

/// A serialisable description of one operation, for the browser to offer.
#[derive(Debug, Clone, Serialize)]
pub struct Offered {
    pub op: &'static str,
    pub label: &'static str,
    /// Whether it rewrites data on disk.
    pub rewrites: bool,
    /// Whether it can destroy data, which decides its tier.
    pub destroys: bool,
    /// The fields the form has to collect.
    pub needs: Vec<&'static str>,
    /// What it costs *on this table*, in the backend's own words.
    ///
    /// Filled in per table rather than written again in the browser. The
    /// alternative was a second copy of six paragraphs in TypeScript, which is
    /// the drift the `SYSTEM` console already had to have removed from it once:
    /// two copies of a warning eventually differ from what the button does.
    #[serde(default)]
    pub costs: String,
}

/// Every operation, with what each one needs.
fn shapes() -> Vec<Offered> {
    vec![
        Offered {
            op: "add-column",
            label: "Add a column",
            rewrites: false,
            destroys: false,
            needs: vec!["column", "kind", "default_expr"],
            costs: String::new(),
        },
        Offered {
            op: "modify-column",
            label: "Change a column's type",
            rewrites: true,
            destroys: false,
            needs: vec!["column", "kind", "default_expr"],
            costs: String::new(),
        },
        Offered {
            op: "rename-column",
            label: "Rename a column",
            rewrites: true,
            destroys: false,
            needs: vec!["column", "to"],
            costs: String::new(),
        },
        Offered {
            op: "drop-column",
            label: "Drop a column",
            rewrites: true,
            destroys: true,
            needs: vec!["column"],
            costs: String::new(),
        },
        Offered {
            op: "modify-ttl",
            label: "Set a TTL",
            rewrites: true,
            destroys: true,
            needs: vec!["expr"],
            costs: String::new(),
        },
        Offered {
            op: "add-index",
            label: "Declare a skip index",
            rewrites: false,
            destroys: false,
            needs: vec!["name", "expression", "kind", "granularity"],
            costs: String::new(),
        },
        Offered {
            op: "materialize-index",
            label: "Build an index",
            rewrites: true,
            destroys: false,
            needs: vec!["name"],
            costs: String::new(),
        },
        Offered {
            op: "drop-index",
            label: "Drop an index",
            rewrites: false,
            destroys: false,
            needs: vec!["name"],
            costs: String::new(),
        },
        Offered {
            op: "add-projection",
            label: "Declare a projection",
            rewrites: false,
            destroys: false,
            needs: vec!["name", "query"],
            costs: String::new(),
        },
        Offered {
            op: "materialize-projection",
            label: "Build a projection",
            rewrites: true,
            destroys: false,
            needs: vec!["name"],
            costs: String::new(),
        },
        Offered {
            op: "drop-projection",
            label: "Drop a projection",
            rewrites: false,
            destroys: false,
            needs: vec!["name"],
            costs: String::new(),
        },
        Offered {
            op: "remove-ttl",
            label: "Remove the TTL",
            rewrites: true,
            destroys: false,
            needs: vec![],
            costs: String::new(),
        },
    ]
}

/// The operations, each with what it would cost this table.
///
/// A representative `Change` per operation is built only to ask `costs` — the
/// column and type in it never reach a statement, and the sentence they produce
/// does not mention them.
pub fn offered(rows: u64, parts: u64, replicated: bool) -> Vec<Offered> {
    shapes()
        .into_iter()
        .map(|mut o| {
            let sample = match o.op {
                "add-column" => Change::AddColumn {
                    column: String::new(),
                    kind: String::new(),
                    default_expr: String::new(),
                },
                "modify-column" => Change::ModifyColumn {
                    column: String::new(),
                    kind: String::new(),
                    default_expr: String::new(),
                },
                "rename-column" => Change::RenameColumn {
                    column: String::new(),
                    to: String::new(),
                },
                "drop-column" => Change::DropColumn {
                    column: "this column".into(),
                },
                "modify-ttl" => Change::ModifyTtl {
                    expr: String::new(),
                },
                "add-index" => Change::AddIndex {
                    name: String::new(),
                    expression: String::new(),
                    kind: String::new(),
                    granularity: 1,
                },
                "materialize-index" => Change::MaterializeIndex {
                    name: String::new(),
                },
                "drop-index" => Change::DropIndex {
                    name: String::new(),
                },
                "add-projection" => Change::AddProjection {
                    name: String::new(),
                    query: String::new(),
                },
                "materialize-projection" => Change::MaterializeProjection {
                    name: String::new(),
                },
                "drop-projection" => Change::DropProjection {
                    name: String::new(),
                },
                _ => Change::RemoveTtl,
            };
            o.costs = costs(&sample, rows, parts, replicated);
            o
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_rewrites_was_measured_and_not_reasoned() {
        // On a table of 400,000 rows in two parts: adding a column made no
        // mutation, with or without a default, and renaming one did.
        assert!(!rewrites(&Change::AddColumn {
            column: "x".into(),
            kind: "UInt8".into(),
            default_expr: String::new(),
        }));
        assert!(!rewrites(&Change::AddColumn {
            column: "x".into(),
            kind: "UInt32".into(),
            default_expr: "id * 2".into(),
        }));
        assert!(rewrites(&Change::RenameColumn {
            column: "a".into(),
            to: "b".into(),
        }));
        assert!(rewrites(&Change::DropColumn { column: "x".into() }));
        assert!(rewrites(&Change::ModifyTtl { expr: "d".into() }));
    }

    #[test]
    fn the_tier_line_is_data_loss_and_only_two_cross_it() {
        assert!(destroys(&Change::DropColumn { column: "x".into() }));
        // A TTL deletes rows already past it, on the next merge.
        assert!(destroys(&Change::ModifyTtl {
            expr: "d + INTERVAL 1 DAY".into()
        }));
        // Removing one stops deletions, which is the other direction.
        assert!(!destroys(&Change::RemoveTtl));
        assert!(!destroys(&Change::RenameColumn {
            column: "a".into(),
            to: "b".into(),
        }));
    }

    #[test]
    fn a_name_is_quoted_and_a_type_is_not() {
        // The type has to reach the server as written — the grammar is large and
        // moves between versions, and Flint refusing what this server
        // understands would be worse than passing it on. The *name* is Flint's
        // to quote.
        let sql = statement(
            &Change::AddColumn {
                column: "we`ird".into(),
                kind: "Map(String, Array(UInt8))".into(),
                default_expr: String::new(),
            },
            "analytics",
            "events",
        );
        assert_eq!(
            sql,
            "ALTER TABLE `analytics`.`events` ADD COLUMN `we``ird` Map(String, Array(UInt8))"
        );
    }

    #[test]
    fn a_default_is_its_own_field_so_it_cannot_ride_in_on_the_type() {
        let sql = statement(
            &Change::AddColumn {
                column: "derived".into(),
                kind: "UInt32".into(),
                default_expr: "id * 2".into(),
            },
            "analytics",
            "events",
        );
        assert!(sql.ends_with("ADD COLUMN `derived` UInt32 DEFAULT id * 2"));
    }

    // Measured against 26.7: `MODIFY COLUMN connected Bool` over a
    // `Nullable(Bool)` is refused outright with BAD_ARGUMENTS — the server will
    // not decide what a null becomes. So the operation has to be able to carry
    // the clause, or the one change the schema review most often proposes is
    // one this panel cannot run.
    #[test]
    fn dropping_a_nullable_can_say_what_a_null_becomes() {
        let sql = statement(
            &Change::ModifyColumn {
                column: "connected".into(),
                kind: "Bool".into(),
                default_expr: "defaultValueOfTypeName('Bool')".into(),
            },
            "default",
            "raw_device_data",
        );
        assert_eq!(
            sql,
            "ALTER TABLE `default`.`raw_device_data` MODIFY COLUMN `connected` Bool DEFAULT \
             defaultValueOfTypeName('Bool')"
        );
        // And the expression is a fragment the route gets to refuse, exactly
        // like the type beside it — it is not a hole a second statement fits
        // through.
        let change = Change::ModifyColumn {
            column: "connected".into(),
            kind: "Bool".into(),
            default_expr: "defaultValueOfTypeName('Bool')".into(),
        };
        assert_eq!(
            fragments(&change),
            vec!["Bool", "defaultValueOfTypeName('Bool')"]
        );
    }

    #[test]
    fn a_retype_with_no_default_is_the_statement_it_always_was() {
        let change = Change::ModifyColumn {
            column: "n".into(),
            kind: "UInt16".into(),
            default_expr: String::new(),
        };
        assert_eq!(
            statement(&change, "db", "t"),
            "ALTER TABLE `db`.`t` MODIFY COLUMN `n` UInt16"
        );
        assert_eq!(fragments(&change), vec!["UInt16"]);
    }

    // The old sentence — "a conversion the server cannot make it refuses
    // outright rather than losing anything" — is true only while there is no
    // default. With one, the refusal becomes a silent conversion, and that is
    // the half a reader about to press the button needs.
    #[test]
    fn a_default_turns_a_refusal_into_a_conversion_and_says_so() {
        let plain = costs(
            &Change::ModifyColumn {
                column: "n".into(),
                kind: "UInt16".into(),
                default_expr: String::new(),
            },
            10,
            1,
            false,
        );
        assert!(plain.contains("refuses outright"));

        let filled = costs(
            &Change::ModifyColumn {
                column: "connected".into(),
                kind: "Bool".into(),
                default_expr: "defaultValueOfTypeName('Bool')".into(),
            },
            10,
            1,
            false,
        );
        assert!(!filled.contains("refuses outright"));
        assert!(filled.contains("nothing brings the original back"));
    }

    #[test]
    fn a_rename_quotes_both_ends() {
        assert_eq!(
            statement(
                &Change::RenameColumn {
                    column: "a".into(),
                    to: "b".into()
                },
                "db",
                "t"
            ),
            "ALTER TABLE `db`.`t` RENAME COLUMN `a` TO `b`"
        );
    }

    #[test]
    fn the_cost_of_adding_a_column_does_not_mention_rewriting() {
        // Because it does not rewrite, and a sentence about parts would be a
        // sentence about the wrong operation.
        let says = costs(
            &Change::AddColumn {
                column: "x".into(),
                kind: "UInt8".into(),
                default_expr: String::new(),
            },
            400_000,
            2,
            false,
        );
        assert!(says.starts_with("Costs nothing now"));
        assert!(!says.contains("Rewrites"));
    }

    #[test]
    fn a_default_column_says_it_is_cheap_to_add_and_not_free_to_read() {
        let says = costs(
            &Change::AddColumn {
                column: "x".into(),
                kind: "UInt32".into(),
                default_expr: "id * 2".into(),
            },
            1,
            1,
            false,
        );
        assert!(says.contains("computed on every read"));
    }

    #[test]
    fn one_part_is_one_part() {
        let says = costs(
            &Change::DropColumn { column: "x".into() },
            500_000,
            1,
            false,
        );
        assert!(says.contains("across 1 part."), "{says}");
        let many = costs(
            &Change::DropColumn { column: "x".into() },
            500_000,
            4,
            false,
        );
        assert!(many.contains("across 4 parts."), "{many}");
    }

    #[test]
    fn an_empty_table_is_not_told_it_will_be_rewritten() {
        let says = costs(&Change::DropColumn { column: "x".into() }, 0, 0, false);
        assert!(says.contains("nothing to rewrite"));
        assert!(!says.contains("Rewrites 0 rows"));
    }

    #[test]
    fn a_replicated_table_is_told_what_done_will_mean() {
        // `alter_sync` defaults to 1, which waits for this replica and not the
        // others — measured at 161 ms with the mutation finished here, against
        // 15 ms and still running at 0.
        let says = costs(&Change::DropColumn { column: "x".into() }, 10, 1, true);
        assert!(says.contains("this replica only"));
        let alone = costs(&Change::DropColumn { column: "x".into() }, 10, 1, false);
        assert!(alone.contains("reports done when the rewrite has finished"));
    }

    #[test]
    fn removing_a_ttl_waits_for_nothing_it_can_promise() {
        // It is a mutation, but there is no per-replica claim worth making about
        // stopping deletions, and the sentence would be noise.
        let says = costs(&Change::RemoveTtl, 10, 1, true);
        assert!(!says.contains("this replica only"));
    }

    #[test]
    fn declaring_an_index_or_a_projection_rewrites_nothing() {
        // Measured: `ADD INDEX by_label label TYPE set(100) GRANULARITY 4` made
        // no mutation and left the index at zero bytes; `MATERIALIZE INDEX`
        // made one and 36 bytes. `ADD PROJECTION` and `MATERIALIZE PROJECTION`
        // behaved the same way, at 0 parts and then one of 761 bytes.
        assert!(!rewrites(&Change::AddIndex {
            name: "i".into(),
            expression: "label".into(),
            kind: "set(100)".into(),
            granularity: 4,
        }));
        assert!(!rewrites(&Change::AddProjection {
            name: "p".into(),
            query: "SELECT 1".into(),
        }));
        assert!(rewrites(&Change::MaterializeIndex { name: "i".into() }));
        assert!(rewrites(&Change::MaterializeProjection {
            name: "p".into()
        }));
        // Dropping either removes derived data, which needs no rewrite of the
        // table.
        assert!(!rewrites(&Change::DropIndex { name: "i".into() }));
        assert!(!rewrites(&Change::DropProjection { name: "p".into() }));
    }

    #[test]
    fn nothing_derived_crosses_the_data_loss_line() {
        // An index and a projection are both computed from the rows, so dropping
        // one loses nothing that cannot be built again.
        for change in [
            Change::AddIndex {
                name: "i".into(),
                expression: "c".into(),
                kind: "minmax".into(),
                granularity: 4,
            },
            Change::DropIndex { name: "i".into() },
            Change::MaterializeIndex { name: "i".into() },
            Change::DropProjection { name: "p".into() },
        ] {
            assert!(!destroys(&change), "{:?}", kind(&change));
        }
    }

    #[test]
    fn declaring_an_index_says_it_does_nothing_yet() {
        // The trap: the statement succeeds and the index is ignored by every
        // query, indefinitely, with no error anywhere.
        let says = costs(
            &Change::AddIndex {
                name: "i".into(),
                expression: "c".into(),
                kind: "minmax".into(),
                granularity: 4,
            },
            500_000,
            1,
            false,
        );
        assert!(says.contains("does nothing now"));
        assert!(says.contains("ignores it until it is built"));
        assert!(!says.contains("Rewrites"));
    }

    #[test]
    fn a_granularity_typed_into_a_form_is_read_as_a_number() {
        // A form sends `"4"`, and refusing the body for the JSON type of a
        // number somebody typed correctly is a refusal nobody can act on.
        let from_text: Change = serde_json::from_str(
            r#"{"op":"add-index","name":"i","expression":"c","kind":"minmax","granularity":"4"}"#,
        )
        .expect("a string granularity should read");
        let from_number: Change = serde_json::from_str(
            r#"{"op":"add-index","name":"i","expression":"c","kind":"minmax","granularity":4}"#,
        )
        .expect("a numeric granularity should read");
        assert_eq!(
            statement(&from_text, "d", "t"),
            statement(&from_number, "d", "t")
        );
        assert!(statement(&from_text, "d", "t").ends_with("GRANULARITY 4"));

        // And something that is not a number is still refused, rather than
        // becoming a zero.
        assert!(serde_json::from_str::<Change>(
            r#"{"op":"add-index","name":"i","expression":"c","kind":"minmax","granularity":"lots"}"#
        )
        .is_err());
    }

    #[test]
    fn a_projection_statement_wraps_its_query_in_parentheses() {
        assert_eq!(
            statement(
                &Change::AddProjection {
                    name: "by_v".into(),
                    query: "SELECT v, count() GROUP BY v".into(),
                },
                "analytics",
                "events"
            ),
            "ALTER TABLE `analytics`.`events` ADD PROJECTION `by_v` (SELECT v, count() GROUP BY v)"
        );
    }

    #[test]
    fn an_index_statement_carries_its_type_and_granularity() {
        assert_eq!(
            statement(
                &Change::AddIndex {
                    name: "by_label".into(),
                    expression: "label".into(),
                    kind: "set(100)".into(),
                    granularity: 4,
                },
                "analytics",
                "events"
            ),
            "ALTER TABLE `analytics`.`events` ADD INDEX `by_label` label TYPE set(100) GRANULARITY 4"
        );
    }

    #[test]
    fn every_offered_operation_has_a_change_that_matches_it() {
        // The catalogue and the enum are two lists, and a form offering an
        // operation the API will not deserialise is a button that fails.
        for o in offered(1, 1, false) {
            let json = match o.op {
                "add-column" => r#"{"op":"add-column","column":"c","kind":"UInt8"}"#,
                "modify-column" => r#"{"op":"modify-column","column":"c","kind":"UInt8"}"#,
                "rename-column" => r#"{"op":"rename-column","column":"c","to":"d"}"#,
                "drop-column" => r#"{"op":"drop-column","column":"c"}"#,
                "modify-ttl" => r#"{"op":"modify-ttl","expr":"d"}"#,
                "add-index" => {
                    r#"{"op":"add-index","name":"i","expression":"c","kind":"minmax","granularity":4}"#
                }
                "materialize-index" => r#"{"op":"materialize-index","name":"i"}"#,
                "drop-index" => r#"{"op":"drop-index","name":"i"}"#,
                "add-projection" => r#"{"op":"add-projection","name":"p","query":"SELECT 1"}"#,
                "materialize-projection" => r#"{"op":"materialize-projection","name":"p"}"#,
                "drop-projection" => r#"{"op":"drop-projection","name":"p"}"#,
                "remove-ttl" => r#"{"op":"remove-ttl"}"#,
                other => panic!("{other} is offered and not covered here"),
            };
            let change: Change =
                serde_json::from_str(json).unwrap_or_else(|e| panic!("{}: {e}", o.op));
            assert_eq!(kind(&change), o.op);
            assert_eq!(rewrites(&change), o.rewrites);
            assert_eq!(destroys(&change), o.destroys);
        }
    }
}
