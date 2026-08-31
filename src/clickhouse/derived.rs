//! Skip indexes and projections: what a table has declared, and what it holds.
//!
//! The two are one subject because they share the trap. **Declaring one does
//! nothing to the data already there**, and the statement that declares it
//! reports success — so a table can carry an index that every query ignores and
//! a projection that answers nothing, indefinitely, with no error anywhere.
//!
//! Measured rather than assumed, on tables of 500,000 and 300,000 rows:
//!
//! | statement | mutation | size after |
//! |---|---|---|
//! | `ADD INDEX by_label label TYPE set(100) GRANULARITY 4` | none | 0 bytes |
//! | `MATERIALIZE INDEX by_label` | one | 36 bytes |
//! | `ADD PROJECTION by_v (SELECT v, count() GROUP BY v)` | none | 0 parts |
//! | `MATERIALIZE PROJECTION by_v` | one | 1 part, 761 bytes |
//!
//! So the observable is size, not status: an index at zero bytes or a projection
//! with no parts is declared and inert. That is the field this module is for, and
//! neither `system.data_skipping_indices` nor `system.projections` says it in
//! words.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions, Section};
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkipIndex {
    pub name: String,
    /// `set(100)`, `minmax`, `bloom_filter(0.01)` — the expression after `TYPE`.
    pub kind: String,
    /// What it indexes.
    pub expression: String,
    pub granularity: u64,
    pub compressed: u64,
    pub uncompressed: u64,
    pub marks: u64,
    /// Declared and holding nothing, which is what `ADD INDEX` leaves behind
    /// until something materialises it.
    #[serde(default)]
    pub inert: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Projection {
    pub name: String,
    /// `Normal` or `Aggregate`.
    pub kind: String,
    pub query: String,
    pub sorting_key: Vec<String>,
    /// Active projection parts, and their bytes. Zero parts is the inert case.
    pub parts: u64,
    pub bytes: u64,
    pub rows: u64,
    #[serde(default)]
    pub inert: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DerivedReport {
    pub indexes: Section<SkipIndex>,
    pub projections: Section<Projection>,
    pub verdicts: Vec<String>,
}

fn params(database: &str, table: &str) -> QueryOptions {
    QueryOptions {
        params: vec![
            ("db".into(), database.to_string()),
            ("tbl".into(), table.to_string()),
        ],
        quote_64bit_integers: false,
        introspection: true,
        ..Default::default()
    }
}

pub async fn derived(ch: &Client, database: &str, table: &str) -> Result<DerivedReport> {
    let indexes: Vec<SkipIndex> = match ch
        .rows_with(
            "SELECT name                       AS name, \
                    type_full                  AS kind, \
                    expr                       AS expression, \
                    granularity                AS granularity, \
                    data_compressed_bytes      AS compressed, \
                    data_uncompressed_bytes    AS uncompressed, \
                    marks_bytes                AS marks \
             FROM system.data_skipping_indices \
             WHERE database = {db:String} AND table = {tbl:String} \
             ORDER BY name",
            params(database, table),
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!("skip indices unavailable: {e}");
            return Ok(DerivedReport {
                indexes: Section::blocked(
                    "system.data_skipping_indices could not be read".to_string(),
                ),
                projections: Section::of(Vec::new()),
                verdicts: Vec::new(),
            });
        }
    };

    // Projections take two reads: the definition from one table and the size
    // from another, because `system.projections` carries no size at all.
    let projections: Vec<Projection> = match ch
        .rows_with(
            "SELECT p.name                                  AS name, \
                    toString(p.type)                        AS kind, \
                    p.query                                 AS query, \
                    p.sorting_key                           AS sorting_key, \
                    s.parts                                 AS parts, \
                    s.bytes                                 AS bytes, \
                    s.rows                                  AS rows \
             FROM system.projections AS p \
             LEFT JOIN ( \
                 SELECT name, count() AS parts, sum(bytes_on_disk) AS bytes, sum(rows) AS rows \
                 FROM system.projection_parts \
                 WHERE database = {db:String} AND table = {tbl:String} AND active \
                 GROUP BY name \
             ) AS s ON s.name = p.name \
             WHERE p.database = {db:String} AND p.table = {tbl:String} \
             ORDER BY p.name",
            params(database, table),
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!("projections unavailable: {e}");
            Vec::new()
        }
    };

    let mut indexes = indexes;
    let mut projections = projections;
    mark_inert(&mut indexes, &mut projections);
    Ok(DerivedReport {
        verdicts: verdicts(&indexes, &projections),
        indexes: Section::of(indexes),
        projections: Section::of(projections),
    })
}

/// Declared and holding nothing.
///
/// The size is the tell, because there is no status column: an index at zero
/// compressed bytes and a projection with no active parts are exactly what
/// `ADD INDEX` and `ADD PROJECTION` leave behind — measured at 0 before
/// `MATERIALIZE` and 36 bytes and one part after.
pub fn mark_inert(indexes: &mut [SkipIndex], projections: &mut [Projection]) {
    for i in indexes.iter_mut() {
        i.inert = i.compressed == 0 && i.marks == 0;
    }
    for p in projections.iter_mut() {
        p.inert = p.parts == 0;
    }
}

pub fn verdicts(indexes: &[SkipIndex], projections: &[Projection]) -> Vec<String> {
    let mut out = Vec::new();
    for i in indexes.iter().filter(|i| i.inert) {
        out.push(format!(
            "Index {} holds nothing. It is in the table's definition and every query ignores it: \
             adding an index does not touch the parts that already exist. Materialising it is \
             what fills it in.",
            i.name
        ));
    }
    for p in projections.iter().filter(|p| p.inert) {
        out.push(format!(
            "Projection {} has no parts, so no query can be answered from it. Adding a \
             projection does not build it over the data already there.",
            p.name
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(name: &str, compressed: u64, marks: u64) -> SkipIndex {
        SkipIndex {
            name: name.into(),
            kind: "set(100)".into(),
            expression: "label".into(),
            granularity: 4,
            compressed,
            uncompressed: compressed * 2,
            marks,
            inert: false,
        }
    }

    fn projection(name: &str, parts: u64) -> Projection {
        Projection {
            name: name.into(),
            kind: "Aggregate".into(),
            query: "SELECT v, count() GROUP BY v".into(),
            sorting_key: vec!["v".into()],
            parts,
            bytes: parts * 761,
            rows: parts * 100,
            inert: false,
        }
    }

    #[test]
    fn size_is_the_tell_because_there_is_no_status() {
        // Measured: `ADD INDEX` leaves 0 bytes and no mutation, `MATERIALIZE`
        // makes it 36 bytes and one mutation. No column says which state it is
        // in.
        let mut indexes = vec![index("fresh", 0, 0), index("built", 36, 8)];
        let mut projections = vec![projection("fresh", 0), projection("built", 1)];
        mark_inert(&mut indexes, &mut projections);
        assert!(indexes[0].inert);
        assert!(!indexes[1].inert);
        assert!(projections[0].inert);
        assert!(!projections[1].inert);
    }

    #[test]
    fn an_index_with_marks_and_no_data_is_not_inert() {
        // A `minmax` index over a small part compresses to nothing while still
        // having marks, and calling that inert would send somebody to
        // materialise what is already there.
        let mut indexes = vec![index("tiny", 0, 8)];
        let mut projections = Vec::new();
        mark_inert(&mut indexes, &mut projections);
        assert!(!indexes[0].inert);
    }

    #[test]
    fn the_verdict_says_what_the_statement_did_not() {
        let mut indexes = vec![index("by_label", 0, 0)];
        let mut projections = vec![projection("by_v", 0)];
        mark_inert(&mut indexes, &mut projections);
        let out = verdicts(&indexes, &projections);
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("every query ignores it"));
        assert!(out[0].contains("does not touch the parts that already exist"));
        assert!(out[1].contains("no query can be answered from it"));
    }

    #[test]
    fn a_built_index_says_nothing() {
        let mut indexes = vec![index("built", 36, 8)];
        let mut projections = vec![projection("built", 1)];
        mark_inert(&mut indexes, &mut projections);
        assert!(verdicts(&indexes, &projections).is_empty());
    }
}
