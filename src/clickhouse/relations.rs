//! What one column says about another.
//!
//! The profile answers questions about a column on its own: how many nulls, how
//! many distinct values, what the range is. This asks the next question, which is
//! the one nobody types because they do not know it can be asked — *which of
//! these columns are saying the same thing twice*.
//!
//! Three findings come out of two passes, and all three are facts about the rows
//! rather than about the DDL:
//!
//! - **A constant.** A column holding one value in every row. It costs disk, it
//!   is in every `SELECT *`, and nothing in the schema says it has stopped
//!   varying — only the data does.
//! - **A determination.** `status_code` fixes `success`: ten status codes, two
//!   booleans, and knowing the first always tells you the second. That is a
//!   candidate for a dictionary, for a materialized column, or for deletion.
//! - **A mirror.** Two columns that determine *each other* — the same
//!   information written twice, in a one-to-one map. `user_host` and
//!   `user_agent` on a real API log: three of each, paired exactly.
//!
//! The test is `uniqExact(tuple(a)) = uniqExact(tuple(a, b))`: if pairing `b`
//! with `a` produces no new combinations, then `a` fixes `b`. `tuple()` around
//! each is not decoration — an aggregate skips NULL, so `uniqExact(a)` counts a
//! different set of rows than `uniqExact((a, b))` on a nullable column, and the
//! comparison would be between two different populations. Wrapped in a tuple,
//! NULL is a value like any other, which is the right reading of "does `a` fix
//! `b`" over the rows that exist.
//!
//! **A near-key determines everything and means nothing.** Measured on a real
//! table before this was written: `process_time`, with 3,771 distinct values in
//! 3,780 rows, "determines" every other column — trivially, because almost every
//! row is its own group. So a column is a candidate only where it groups the
//! table into meaningfully fewer parts than it has rows, and that rule is the
//! difference between a finding and a list of noise.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions, Reach};
use crate::error::{Error, Result};

/// What kind of thing was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// One value in every row.
    Constant,
    /// `a` fixes `b`, and `b` does not fix `a`.
    Determines,
    /// Each fixes the other: the same information twice.
    Mirrors,
    /// Two numbers that move together almost exactly — a straight line through
    /// the rows. Redundancy of a different shape than a mirror: not the same
    /// values, but no independent information.
    MovesWith,
    /// Two numbers that move together, without being each other.
    Correlates,
    /// A numeric column with values far outside the middle of its own
    /// distribution.
    FarValues,
    /// One value covering most of the column.
    Dominant,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub kind: Kind,
    pub a: String,
    pub a_distinct: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b_distinct: Option<u64>,
    /// The one value, for a constant. Absent where it is NULL, which is itself
    /// worth seeing and is said in words rather than printed as a word.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Pearson's r, for the two correlation kinds. Signed: a correlation of
    /// −0.9 is as strong a statement as +0.9 and a different one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r: Option<f64>,
    /// Rows both columns were present in. Lower than the table's rows wherever
    /// either is nullable, because a correlation is computed over the pairs that
    /// exist — verified against a server rather than assumed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compared: Option<u64>,
    /// For a column with far values: how many rows sit beyond each fence, where
    /// the fences are, and how far the furthest value actually goes. All of it,
    /// because "there are outliers" is a claim and these are the figures that
    /// let somebody judge it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub above: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub below: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fence_high: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fence_low: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low: Option<f64>,
    /// The middle of the distribution these fences were drawn from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q3: Option<f64>,
    /// For a dominant value: how many rows carry it. The value itself travels in
    /// `value`, as a constant's does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub covering: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Relations {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Rows the two passes read. The whole table: a prefix would find
    /// dependencies that hold in the first million rows and nowhere else, which
    /// is worse than finding none.
    pub rows: u64,
    pub findings: Vec<Finding>,
    /// Columns the table has, and how many survived to be paired.
    pub columns: u64,
    pub considered: u64,
    /// Why the rest did not: a column with one value has nothing to determine,
    /// and a column with almost as many values as there are rows determines
    /// everything.
    pub skipped_constant: u64,
    pub skipped_unique: u64,
    /// True where either candidate cap trimmed a list before pairing.
    pub capped: bool,
    /// Numeric columns compared against each other.
    pub numeric: u64,
}

impl Finding {
    /// A finding with only what every kind has. Each site fills the rest through
    /// struct update — eight optional fields spelled `None` at four call sites
    /// is how one of them ends up meaning something it should not.
    fn of(kind: Kind, a: &str, a_distinct: u64) -> Self {
        Self {
            kind,
            a: a.to_string(),
            a_distinct,
            b: None,
            b_distinct: None,
            value: None,
            r: None,
            compared: None,
            above: None,
            below: None,
            fence_high: None,
            fence_low: None,
            high: None,
            low: None,
            q1: None,
            q3: None,
            covering: None,
        }
    }
}

/// A column is a candidate while it groups the table into fewer than this share
/// of its rows. Above it, the column is close enough to a key that "it
/// determines everything" is arithmetic rather than a finding.
const NEAR_KEY: f64 = 0.30;
/// How many candidates are paired. The pair query is one pass with n(n-1)/2
/// aggregates in it, so this is the figure that decides its width: sixteen
/// columns is 120 aggregates, which a real server answered in a tenth of a
/// second over four thousand rows.
const MAX_CANDIDATES: usize = 16;
/// Above this, two numbers are a straight line and one of them is derivable from
/// the other. Not 1.0: a computed column with a rounding step lands at 0.999…,
/// and refusing to call that a straight line would be pedantry about float.
const EXACT: f64 = 0.99;
/// How many interquartile ranges past the quarters a value has to be to count as
/// far out. Tukey's own figure for a *far* outlier; the more familiar 1.5 marks
/// a value as merely unusual, and on the skewed distributions a database is full
/// of — durations, sizes, counts — 1.5 flags a tenth of the table and says
/// nothing.
const FENCE: f64 = 3.0;
/// And a share of the rows beyond which the far values are not exceptions but
/// the shape of the column.
///
/// Measured before it was chosen: Tukey's fences put 19% of `system.parts.rows`
/// and 10% of a duration column past the far fence, because both distributions
/// are heavy-tailed — which is true arithmetic and a useless finding. "Forty-two
/// of your two hundred rows are outliers" describes a skew, and calling it an
/// outlier report would teach a reader to stop reading them.
const FAR_SHARE: f64 = 0.05;
/// The share of a column one value has to cover before its dominance is worth
/// saying. Below four fifths a column merely leans; at four fifths it is a
/// constant with exceptions, which changes what an index on it is worth, what
/// partitioning by it would do, and whether a filter on it narrows anything.
const DOMINANT: f64 = 0.8;
/// And below this, a correlation is not worth a reader's attention. Real tables
/// are full of weak ones — measured on a real table, two unrelated columns of an
/// API log sit at 0.004 — and a list that includes them is a list nobody
/// finishes.
const NOTABLE: f64 = 0.6;

pub async fn relations(ch: &Client, database: &str, table: &str) -> Result<Relations> {
    if let Some(why) = blocked(ch).await? {
        return Ok(empty(Some(why)));
    }

    #[derive(Deserialize)]
    struct Column {
        name: String,
        r#type: String,
    }
    let columns: Vec<Column> = ch
        .rows_with(
            "SELECT name AS name, type AS type FROM system.columns \
             WHERE database = {db:String} AND table = {tbl:String} \
             ORDER BY position",
            params(database, table),
        )
        .await?;
    if columns.len() < 2 {
        return Ok(Relations {
            available: true,
            reason: None,
            rows: 0,
            findings: Vec::new(),
            columns: columns.len() as u64,
            considered: 0,
            skipped_constant: 0,
            skipped_unique: 0,
            capped: false,
            numeric: 0,
        });
    }

    /* First pass: how many values each column takes, and what the value is where
    there is only one. Every column, because this is what decides which of them
    can be interesting — and it is a single scan whatever the width. */
    let mut select = vec!["toUInt64(count()) AS n".to_string()];
    for (i, c) in columns.iter().enumerate() {
        let q = quote(&c.name);
        select.push(format!("toUInt64(uniqExact(tuple({q}))) AS u{i}"));
        select.push(format!("toString(any({q})) AS v{i}"));
        // The most common value, stringified — its share cannot be counted in
        // the same pass, since that would put an aggregate inside an aggregate
        // and the server refuses it.
        select.push(format!("toString(topK(1)({q})[1]) AS t{i}"));
        if numeric(&c.r#type) {
            /* The quarters and the ends, in the pass that is already reading the
            table. The fences they imply cannot be computed here — an
            aggregate inside an aggregate is refused, which is the server
            telling you the same thing — so they are worked out between the
            passes and counted in the second. */
            select.push(format!(
                "toFloat64OrNull(toString(quantile(0.25)({q}))) AS q1_{i}"
            ));
            select.push(format!(
                "toFloat64OrNull(toString(quantile(0.75)({q}))) AS q3_{i}"
            ));
            select.push(format!("toFloat64OrNull(toString(min({q}))) AS mn_{i}"));
            select.push(format!("toFloat64OrNull(toString(max({q}))) AS mx_{i}"));
        }
    }
    let first = format!(
        "SELECT {} FROM {{db:Identifier}}.{{tbl:Identifier}}",
        select.join(", ")
    );
    let counts: serde_json::Value = match ch.row_with(&first, params(database, table)).await {
        Ok(Some(row)) => row,
        Ok(None) => return Ok(empty(Some("the table answered nothing".into()))),
        Err(e) if refused(&e) => return Ok(empty(Some(said(&e)))),
        Err(e) => return Err(e),
    };
    let rows = num(&counts, "n");
    if rows == 0 {
        return Ok(Relations {
            available: true,
            reason: None,
            rows: 0,
            findings: Vec::new(),
            columns: columns.len() as u64,
            considered: 0,
            skipped_constant: 0,
            skipped_unique: 0,
            capped: false,
            numeric: 0,
        });
    }

    let mut findings = Vec::new();
    let mut candidates: Vec<(usize, u64)> = Vec::new();
    let mut skipped_constant = 0;
    let mut skipped_unique = 0;
    for (i, c) in columns.iter().enumerate() {
        let distinct = num(&counts, &format!("u{i}"));
        if distinct <= 1 {
            skipped_constant += 1;
            findings.push(Finding {
                value: text(&counts, &format!("v{i}")),
                ..Finding::of(Kind::Constant, &c.name, distinct)
            });
            continue;
        }
        if (distinct as f64) > NEAR_KEY * rows as f64 {
            skipped_unique += 1;
            continue;
        }
        candidates.push((i, distinct));
    }

    /* Correlation has its own candidates, and they are not the same ones. A
    near-key is useless for determination and is exactly what a correlation is
    for — `process_time` explains nothing by grouping and may still track
    another number precisely. So: numeric, and not constant, since a column
    that never varies has no correlation and ClickHouse answers NaN. */
    let mut numbers: Vec<(usize, u64)> = columns
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let distinct = num(&counts, &format!("u{i}"));
            (numeric(&c.r#type) && distinct > 1).then_some((i, distinct))
        })
        .collect();
    let numbers_capped = numbers.len() > MAX_CANDIDATES;
    numbers.truncate(MAX_CANDIDATES);

    // Fewest values first: a column that cuts the table into ten groups is a
    // better explanation of another column than one that cuts it into a
    // thousand, and the cap should keep the better ones.
    candidates.sort_by_key(|(_, distinct)| *distinct);
    let capped = candidates.len() > MAX_CANDIDATES;
    candidates.truncate(MAX_CANDIDATES);
    let considered = candidates.len() as u64;

    if considered >= 2 || numbers.len() >= 2 {
        /* One pass for both families. They ask different questions of different
        columns, and asking them separately would read the table twice for no
        reason — the scan is the expensive part, not the aggregates in it. */
        let mut pairs = Vec::new();
        for (x, (i, _)) in candidates.iter().enumerate() {
            for (j, _) in candidates.iter().skip(x + 1) {
                let a = quote(&columns[*i].name);
                let b = quote(&columns[*j].name);
                pairs.push(format!("toUInt64(uniqExact(tuple({a}, {b}))) AS p{i}_{j}"));
            }
        }
        /* How far the most common value of each candidate reaches.

        The value is *data*, and this is the only place in the module where a
        value from the table would otherwise be written into SQL. It is bound
        as a parameter and the column is stringified to meet it: a table
        holding `'); DROP` in a `LowCardinality(String)` is a table Flint
        reads like any other. */
        let mut tops: Vec<(usize, String)> = Vec::new();
        for (i, _) in candidates.iter() {
            let Some(top) = text(&counts, &format!("t{i}")) else {
                continue;
            };
            pairs.push(format!(
                "toUInt64(countIf(toString({c}) = {{tv{i}:String}})) AS d{i}",
                c = quote(&columns[*i].name)
            ));
            tops.push((*i, top));
        }

        /* The fences, from the quarters the first pass measured. A column whose
        middle half is a single value has no spread to be far from, and a
        fence there would call every other value an outlier — so it is left
        alone rather than reported as one long list of them. */
        let mut fences: Vec<(usize, f64, f64)> = Vec::new();
        for (i, _) in numbers.iter() {
            let (Some(q1), Some(q3)) = (
                counts.get(format!("q1_{i}")).and_then(|v| v.as_f64()),
                counts.get(format!("q3_{i}")).and_then(|v| v.as_f64()),
            ) else {
                continue;
            };
            let iqr = q3 - q1;
            if iqr <= 0.0 || !iqr.is_finite() {
                continue;
            }
            let (low, high) = (q1 - FENCE * iqr, q3 + FENCE * iqr);
            pairs.push(format!(
                "toUInt64(countIf({c} > {high})) AS hi{i}",
                c = quote(&columns[*i].name)
            ));
            pairs.push(format!(
                "toUInt64(countIf({c} < {low})) AS lo{i}",
                c = quote(&columns[*i].name)
            ));
            fences.push((*i, low, high));
        }

        for (x, (i, _)) in numbers.iter().enumerate() {
            for (j, _) in numbers.iter().skip(x + 1) {
                let a = quote(&columns[*i].name);
                let b = quote(&columns[*j].name);
                pairs.push(format!("corr({a}, {b}) AS r{i}_{j}"));
                // What the correlation was actually taken over. `corr` skips a
                // row where either side is NULL — verified against a server —
                // so on a nullable column this is below the table's rows, and a
                // figure drawn from fewer rows should say how many.
                pairs.push(format!(
                    "toUInt64(countIf(isNotNull({a}) AND isNotNull({b}))) AS c{i}_{j}"
                ));
            }
        }
        let second = format!(
            "SELECT {} FROM {{db:Identifier}}.{{tbl:Identifier}}",
            pairs.join(", ")
        );
        let mut opts = params(database, table);
        for (i, top) in &tops {
            opts.params.push((format!("tv{i}"), top.clone()));
        }
        let together: serde_json::Value = match ch.row_with(&second, opts).await {
            Ok(Some(row)) => row,
            Ok(None) => serde_json::Value::Null,
            Err(e) if refused(&e) => return Ok(empty(Some(said(&e)))),
            Err(e) => return Err(e),
        };

        for (i, top) in tops {
            let covering = num(&together, &format!("d{i}"));
            if (covering as f64) < DOMINANT * rows as f64 {
                continue;
            }
            findings.push(Finding {
                value: Some(top),
                covering: Some(covering),
                ..Finding::of(
                    Kind::Dominant,
                    &columns[i].name,
                    num(&counts, &format!("u{i}")),
                )
            });
        }

        for (i, low, high) in fences {
            let above = num(&together, &format!("hi{i}"));
            let below = num(&together, &format!("lo{i}"));
            if above == 0 && below == 0 {
                continue;
            }
            if (above + below) as f64 > FAR_SHARE * rows as f64 {
                continue;
            }
            findings.push(Finding {
                above: (above > 0).then_some(above),
                below: (below > 0).then_some(below),
                fence_high: (above > 0).then_some(high),
                fence_low: (below > 0).then_some(low),
                high: counts.get(format!("mx_{i}")).and_then(|v| v.as_f64()),
                low: counts.get(format!("mn_{i}")).and_then(|v| v.as_f64()),
                q1: counts.get(format!("q1_{i}")).and_then(|v| v.as_f64()),
                q3: counts.get(format!("q3_{i}")).and_then(|v| v.as_f64()),
                ..Finding::of(
                    Kind::FarValues,
                    &columns[i].name,
                    num(&counts, &format!("u{i}")),
                )
            });
        }

        for (x, (i, _)) in numbers.iter().enumerate() {
            for (j, _) in numbers.iter().skip(x + 1) {
                let Some(r) = together.get(format!("r{i}_{j}")).and_then(|v| v.as_f64()) else {
                    // NaN arrives as null: one of the two never varies over the
                    // rows where both are present. Not a finding, and not an
                    // error either.
                    continue;
                };
                let Some(kind) = classify(r) else {
                    continue;
                };
                findings.push(Finding {
                    b: Some(columns[*j].name.clone()),
                    b_distinct: Some(num(&counts, &format!("u{j}"))),
                    r: Some(r),
                    compared: Some(num(&together, &format!("c{i}_{j}"))),
                    ..Finding::of(kind, &columns[*i].name, num(&counts, &format!("u{i}")))
                });
            }
        }

        for (x, (i, ui)) in candidates.iter().enumerate() {
            for (j, uj) in candidates.iter().skip(x + 1) {
                let both = num(&together, &format!("p{i}_{j}"));
                if both == 0 {
                    continue;
                }
                let a_fixes_b = both == *ui;
                let b_fixes_a = both == *uj;
                let (kind, first, first_u, second_name, second_u) = match (a_fixes_b, b_fixes_a) {
                    (true, true) => (
                        Kind::Mirrors,
                        &columns[*i].name,
                        *ui,
                        &columns[*j].name,
                        *uj,
                    ),
                    (true, false) => (
                        Kind::Determines,
                        &columns[*i].name,
                        *ui,
                        &columns[*j].name,
                        *uj,
                    ),
                    (false, true) => (
                        Kind::Determines,
                        &columns[*j].name,
                        *uj,
                        &columns[*i].name,
                        *ui,
                    ),
                    (false, false) => continue,
                };
                findings.push(Finding {
                    b: Some(second_name.clone()),
                    b_distinct: Some(second_u),
                    ..Finding::of(kind, first, first_u)
                });
            }
        }
    }

    /* Mirrors first, then determinations by how *coarse* the determinant is,
    and constants last.

    Coarsest first because that is what makes a rule actionable rather than
    merely true. On a real table: `status_code` has ten values and fixes a
    boolean — a rule somebody could write down. `time` has two hundred and
    ninety-two and also fixes a three-valued column, which is a real pattern in
    those rows and no kind of rule. Both are findings; only one is the first
    thing to show, and ranking by what is *determined* put the weaker one on
    top. */
    findings.sort_by(|l, r| {
        /* A mirror and a straight line are the same news — this column adds
        nothing — so they lead. A correlation is a fact about the data worth
        knowing; a determination is a rule; a constant is neither and is
        last. */
        let rank = |f: &Finding| match f.kind {
            Kind::Mirrors => 0,
            Kind::MovesWith => 1,
            Kind::Correlates => 2,
            Kind::Determines => 3,
            // Far values are about one column and about the rows rather than
            // about a relationship, so they sit with the other single-column
            // fact rather than among the pairs.
            Kind::FarValues => 4,
            // A dominant value and a constant are the same shape of fact — this
            // column varies less than its type suggests — so they sit together,
            // the stronger statement first.
            Kind::Dominant => 5,
            Kind::Constant => 6,
        };
        // Within the correlations, the strongest first; within the rest, the
        // coarsest determinant first. Two orders because they are two questions.
        let strength = |f: &Finding| (f.r.unwrap_or(0.0).abs() * 1000.0) as i64;
        rank(l)
            .cmp(&rank(r))
            .then(strength(r).cmp(&strength(l)))
            // And within the dominant values, the widest reach first — 95% is a
            // stronger statement than 85% and was arriving after it.
            .then(r.covering.unwrap_or(0).cmp(&l.covering.unwrap_or(0)))
            .then(l.a_distinct.cmp(&r.a_distinct))
            .then(r.b_distinct.unwrap_or(0).cmp(&l.b_distinct.unwrap_or(0)))
            .then(l.a.cmp(&r.a))
    });

    Ok(Relations {
        available: true,
        reason: None,
        rows,
        findings,
        columns: columns.len() as u64,
        considered,
        skipped_constant,
        skipped_unique,
        capped: capped || numbers_capped,
        numeric: numbers.len() as u64,
    })
}

fn params(database: &str, table: &str) -> QueryOptions {
    QueryOptions {
        params: vec![
            ("db".into(), database.to_string()),
            ("tbl".into(), table.to_string()),
        ],
        ..QueryOptions::internal()
    }
}

/// A column name inside an expression. Backticks doubled, which is ClickHouse's
/// own escape — a column really can be called `` a`b ``, and this is the one
/// place in the module where an identifier is not a bound parameter, because a
/// parameter cannot be an expression.
/// Which finding a correlation is, if any.
///
/// By strength alone: −0.98 is as strong a statement as +0.98, and the sign
/// belongs in the sentence rather than in the decision. NaN — which is what
/// ClickHouse answers where one side never varies — is not a weak correlation
/// but the absence of one, and falls out here as `None`.
fn classify(r: f64) -> Option<Kind> {
    if !r.is_finite() || r.abs() < NOTABLE {
        None
    } else if r.abs() >= EXACT {
        Some(Kind::MovesWith)
    } else {
        Some(Kind::Correlates)
    }
}

/// Whether a declared type is a number Pearson's r can be taken of.
///
/// Wrappers are peeled rather than matched: `Nullable(Decimal(9, 2))` is a
/// number, and so is `LowCardinality(Nullable(UInt8))`. Dates deliberately are
/// not — a correlation between two timestamps is almost always the fact that
/// both go up, which is a property of time and not of the table.
fn numeric(declared: &str) -> bool {
    let mut t = declared.trim();
    loop {
        let peeled = t
            .strip_prefix("Nullable(")
            .or_else(|| t.strip_prefix("LowCardinality("))
            .and_then(|rest| rest.strip_suffix(')'));
        match peeled {
            Some(inner) => t = inner.trim(),
            None => break,
        }
    }
    t.starts_with("Int")
        || t.starts_with("UInt")
        || t.starts_with("Float")
        || t.starts_with("BFloat")
        || t.starts_with("Decimal")
}

fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn num(row: &serde_json::Value, key: &str) -> u64 {
    row.get(key)
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0)
}

fn text(row: &serde_json::Value, key: &str) -> Option<String> {
    match row.get(key) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(serde_json::Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}

/// The refusals worth turning into a sentence rather than a 500: a scan this
/// wide can exhaust the memory a server allows one query, and a role can be
/// denied the table itself.
fn refused(e: &Error) -> bool {
    matches!(
        e,
        Error::ClickHouse { code: 241, .. }   // MEMORY_LIMIT_EXCEEDED
            | Error::ClickHouse { code: 497, .. } // ACCESS_DENIED
            | Error::ClickHouse { code: 158, .. } // TOO_MANY_ROWS
            | Error::ClickHouse { code: 159, .. } // TIMEOUT_EXCEEDED
    )
}

fn said(e: &Error) -> String {
    match e {
        Error::ClickHouse { code: 241, .. } => {
            "this table is too wide for one pass within the server's memory limit — the \
             comparison holds every distinct combination at once"
                .to_string()
        }
        Error::ClickHouse { code: 159, .. } => "the scan ran past the query timeout".to_string(),
        other => other.to_string().lines().next().unwrap_or("").to_string(),
    }
}

fn empty(reason: Option<String>) -> Relations {
    Relations {
        available: false,
        reason,
        rows: 0,
        findings: Vec::new(),
        columns: 0,
        considered: 0,
        skipped_constant: 0,
        skipped_unique: 0,
        capped: false,
        numeric: 0,
    }
}

async fn blocked(ch: &Client) -> Result<Option<String>> {
    Ok(match ch.reach("columns").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user is not granted SELECT on system.columns".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.columns".to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_column_name_is_quoted_the_way_clickhouse_escapes_one() {
        // A parameter cannot be an expression, so this is the one identifier the
        // module writes itself — and a column really can be called `a`b`.
        assert_eq!(quote("plain"), "`plain`");
        assert_eq!(quote("a`b"), "`a``b`");
    }

    #[test]
    fn a_number_is_recognised_through_its_wrappers() {
        // `Nullable(Decimal(9, 2))` is a number and so is
        // `LowCardinality(Nullable(UInt8))`; a correlation between two
        // timestamps is mostly the fact that time goes up.
        assert!(numeric("UInt64"));
        assert!(numeric("Nullable(Decimal(9, 2))"));
        assert!(numeric("LowCardinality(Nullable(UInt8))"));
        assert!(!numeric("String"));
        assert!(!numeric("DateTime"));
        assert!(!numeric("Array(UInt8)"));
    }

    #[test]
    fn a_correlation_is_classified_by_its_strength_and_not_its_sign() {
        // 0.999… is a computed column with a rounding step, and calling that
        // anything but a straight line is pedantry about float. 0.004 is what
        // two unrelated columns of a real API log measured. And −0.98 is as
        // strong a statement as +0.98: the sign belongs in the sentence, not in
        // the decision.
        assert_eq!(classify(1.0), Some(Kind::MovesWith));
        assert_eq!(classify(-0.9995), Some(Kind::MovesWith));
        assert_eq!(classify(0.87), Some(Kind::Correlates));
        assert_eq!(classify(-0.87), Some(Kind::Correlates));
        assert_eq!(classify(0.004), None);
        assert_eq!(classify(f64::NAN), None);
    }

    #[test]
    fn a_near_key_is_not_a_candidate() {
        // Measured before it was written: 3,771 distinct values in 3,780 rows
        // "determines" every other column, trivially, because almost every row
        // is its own group.
        let rows = 3780f64;
        assert!((3771f64) > NEAR_KEY * rows);
        assert!((10f64) <= NEAR_KEY * rows);
    }
}
