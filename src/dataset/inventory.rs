//! What each column of a dataset can be asked to do.
//!
//! A filter only ever needs to know a column's *type*, which is why the query
//! string has managed without any of this. A `group by` needs something else: it
//! has to know that `meter_id` identifies a row rather than measures one, so
//! that `sum(meter_id)` is refused instead of returning a number that means
//! nothing. That distinction is not in the type — `meter_id` and `reading` are
//! both `UInt64` — and it is the whole reason this module exists.
//!
//! **Derived, never declared.** The alternative, and it is what a semantic layer
//! usually ends up with, is a file listing every dataset and every column with
//! its role written out by hand. It works, and it costs a pull request every
//! time somebody adds a table. Flint already holds each input: `system.columns`
//! through `meta.rs`, the type families in `published::shape`, the cardinality
//! and the values in `profile.rs`. So the inventory is computed, and a view the
//! ops team adds on a Tuesday can be grouped and measured on the Tuesday.
//!
//! What is derived is a **proposal**, and it is worth being honest about the one
//! place it guesses. A column called `order_id` is an identifier because of its
//! name, not because of anything ClickHouse knows — and a column genuinely
//! called `pyramid` would be caught by a careless suffix rule. The rules below
//! are therefore deliberately narrow: a whole-word `id`, or a `_id`/`_uid`/
//! `_uuid` ending, and nothing cleverer. Where the guess is wrong the caller can
//! still filter, group and select the column; the only thing withheld is the
//! arithmetic, which is the one operation that would have produced a plausible
//! wrong number rather than an error.

use serde::Serialize;

use crate::clickhouse::ColumnMeta;
use crate::published::shape::{self, Agg, Aggregate, Family};

/// What a column *is*, for the purpose of asking questions of it.
///
/// Coarser than a type on purpose. Two columns that behave the same way in a
/// `GROUP BY` and in an aggregate belong in the same kind, whatever ClickHouse
/// stores them as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Identifies the subject of a row. It groups, and it never measures: the
    /// average of a customer id is a number with no meaning, and returning one
    /// is worse than refusing.
    Id,
    /// A point in time. The column a period, a range or a granularity is
    /// applied to.
    Time,
    Bool,
    /// Text, and enums with it — a caller who knows an enum knows its labels.
    Text,
    /// A quantity. The only kind arithmetic is offered on.
    Numeric,
    /// Returned, and nothing else. Arrays, maps, tuples, nested — one column
    /// holding many values, which neither groups nor measures. Said here rather
    /// than discovered in a 400.
    Unsupported,
}

impl Kind {
    /// Whether a `GROUP BY` may name this column.
    pub const fn groups(self) -> bool {
        !matches!(self, Kind::Unsupported)
    }

    /// The aggregations this kind accepts, in the order they are worth offering.
    ///
    /// `count` is on everything that exists, because counting rows never asks
    /// anything of the values. Everything past it does, and the list narrows
    /// accordingly: `min`/`max` want an order, `sum`/`avg`/`median` want
    /// arithmetic, and only `Numeric` has both.
    pub fn aggregations(self) -> Vec<Agg> {
        match self {
            Kind::Numeric => vec![
                Agg::Count,
                Agg::Sum,
                Agg::Avg,
                Agg::Min,
                Agg::Max,
                Agg::Median,
                // Percentiles are arithmetic on an order, so they belong here
                // and nowhere else — a 95th-percentile city name is not a
                // thing.
                Agg::P95,
                Agg::P99,
                Agg::DistinctCount,
                Agg::DistinctApprox,
                Agg::Any,
            ],
            // An order but no arithmetic: the earliest and the latest are
            // exactly what anyone wants from a timestamp, and its sum is not a
            // time.
            Kind::Time | Kind::Text => {
                vec![
                    Agg::Count,
                    Agg::Min,
                    Agg::Max,
                    Agg::DistinctCount,
                    Agg::DistinctApprox,
                    Agg::Any,
                ]
            }
            // Neither: how many, and how many distinct. `sum` over a boolean
            // does count the trues, and offering it under that name would have
            // people reading it as something else.
            Kind::Bool | Kind::Id => vec![
                Agg::Count,
                Agg::DistinctCount,
                Agg::DistinctApprox,
                Agg::Any,
            ],
            Kind::Unsupported => Vec::new(),
        }
    }

    /// Whether this kind accepts that aggregation.
    pub fn accepts(self, agg: Agg) -> bool {
        self.aggregations().contains(&agg)
    }
}

/// One column, and everything a caller may do with it.
#[derive(Debug, Clone, Serialize)]
pub struct Column {
    pub name: String,
    pub r#type: String,
    pub kind: Kind,
    /// Whether this column may appear in `dimensions`.
    pub group: bool,
    /// Operators this column can be filtered with. Empty means it is returned
    /// but not filterable.
    pub filter: Vec<&'static str>,
    /// Aggregations this column accepts as a metric, by keyword.
    pub aggregate: Vec<&'static str>,
    /// Only where it is true, because it is the case that changes what a filter
    /// can ask: `isnull` is offered on a `Nullable` column and nowhere else.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub nullable: bool,
}

/// The whole dataset, described.
#[derive(Debug, Clone, Serialize)]
pub struct Inventory {
    pub dataset: String,
    pub columns: Vec<Column>,
    /// How many of the columns above can carry a metric, and how many cannot.
    /// A count rather than a filtered list, because dropping the others from
    /// the list would leave a caller unable to find a column that is there.
    pub measurable: usize,
    pub groupable: usize,
    /// Said out loud when some column is returned and can do nothing else, so a
    /// caller reads it as a fact about the data rather than an omission.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Whether a name reads as an identifier rather than as a quantity.
///
/// Narrow on purpose — see the module's opening. `id` on its own, or a name
/// ending in `_id`, `_uid` or `_uuid`. Nothing matches on a bare suffix, so
/// `valid`, `pyramid` and `overbid` are quantities, which is what they are.
fn reads_as_identifier(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "id"
        || lower == "uuid"
        || lower.ends_with("_id")
        || lower.ends_with("_uid")
        || lower.ends_with("_uuid")
}

/// What kind a column is, from its type and — for identifiers only — its name.
pub fn kind_of(column: &ColumnMeta) -> Kind {
    let family = shape::family(&column.r#type);

    // A UUID is an identifier whatever it is called; there is no arithmetic on
    // one to withhold, and calling it text would offer `like` on a value nobody
    // pattern-matches.
    if matches!(shape::base_type(&column.r#type), "UUID") {
        return Kind::Id;
    }

    // A `Kind` answers "what may be asked of this column", not "what does it
    // mean". So a `device_id` that is a `String` stays `Text` — `like` on it is
    // a real question and its lexicographic bounds cost nobody a wrong number —
    // while a numeric one becomes `Id`, because that is where the damage is.
    // The name is consulted only where consulting it prevents something.
    match family {
        Family::Other => Kind::Unsupported,
        Family::Temporal => Kind::Time,
        // `Native` is `Bool`, `UUID`, `IPv4`, `IPv6`. The first is its own kind;
        // an address identifies a machine and does not measure one.
        Family::Native => match shape::base_type(&column.r#type) {
            "Bool" | "Boolean" => Kind::Bool,
            _ => Kind::Id,
        },
        Family::Text => Kind::Text,
        // The only place the name is consulted, and the only place it can be
        // wrong. Withholding arithmetic from a real quantity costs a caller an
        // error message; offering it on an identifier costs them a plausible
        // number, and they may never find out.
        Family::Number if reads_as_identifier(&column.name) => Kind::Id,
        Family::Number => Kind::Numeric,
    }
}

/// Describe a dataset's columns.
pub fn describe(dataset: &str, columns: &[ColumnMeta]) -> Inventory {
    let columns: Vec<Column> = columns
        .iter()
        .map(|c| {
            let kind = kind_of(c);
            Column {
                name: c.name.clone(),
                r#type: c.r#type.clone(),
                kind,
                group: kind.groups(),
                filter: shape::ops_for(&c.r#type),
                aggregate: kind.aggregations().into_iter().map(Agg::keyword).collect(),
                nullable: shape::is_nullable(&c.r#type),
            }
        })
        .collect();

    let measurable = columns.iter().filter(|c| !c.aggregate.is_empty()).count();
    let groupable = columns.iter().filter(|c| c.group).count();
    let opaque = columns.len() - groupable;

    Inventory {
        dataset: dataset.to_string(),
        note: (opaque > 0).then(|| {
            let (holds, they) = if opaque == 1 {
                ("holds", "it is")
            } else {
                ("hold", "they are")
            };
            format!(
                "{opaque} of {} columns {holds} many values at once — {they} returned, and \
                 cannot be filtered, grouped or measured",
                columns.len()
            )
        }),
        measurable,
        groupable,
        columns,
    }
}

/// Whether every metric in this request is one its column can carry.
///
/// The check the type system cannot do, and the reason the inventory exists.
/// `sum(meter_id)` compiles, runs, and returns a number that means nothing —
/// so it is refused here, by name, with the aggregations that column *does*
/// take, because a caller told only "no" will try the next one on the list.
///
/// Dimensions are checked too, for the one case that has an answer worth
/// giving: grouping by an `Array` column is not a narrower question, it is a
/// type error waiting to happen further down.
pub fn permits(columns: &[ColumnMeta], aggregate: &Aggregate) -> Result<(), String> {
    let find = |name: &str| columns.iter().find(|c| c.name == name);

    for name in &aggregate.dimensions {
        let Some(column) = find(name) else {
            // Left to `shape`, which knows every column and can list them.
            continue;
        };
        if !kind_of(column).groups() {
            return Err(format!(
                "`{name}` is {} — it holds many values at once, so it cannot be grouped by",
                column.r#type
            ));
        }
    }

    for metric in &aggregate.metrics {
        let Some(name) = &metric.column else {
            continue;
        };
        let Some(column) = find(name) else {
            continue;
        };
        let kind = kind_of(column);
        if kind.accepts(metric.aggregation) {
            continue;
        }

        let takes = kind.aggregations();
        return Err(if takes.is_empty() {
            format!(
                "`{name}` is {} — it holds many values at once, so nothing can be measured \
                 over it",
                column.r#type
            )
        } else {
            format!(
                "`{name}` does not take `{}`; it takes {}",
                metric.aggregation.keyword(),
                takes
                    .into_iter()
                    .map(Agg::keyword)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            r#type: ty.into(),
        }
    }

    fn kind(name: &str, ty: &str) -> Kind {
        kind_of(&col(name, ty))
    }

    #[test]
    fn a_quantity_is_a_quantity() {
        assert_eq!(kind("amount", "Float64"), Kind::Numeric);
        assert_eq!(kind("n", "UInt64"), Kind::Numeric);
        assert_eq!(kind("price", "Decimal(18, 2)"), Kind::Numeric);
        // Storage wrappers say nothing about what a value means.
        assert_eq!(kind("amount", "Nullable(Float64)"), Kind::Numeric);
    }

    #[test]
    fn an_identifier_that_happens_to_be_a_number_is_still_an_identifier() {
        // The case the whole module is for: these two are the same type, and
        // one of them has no meaningful average.
        assert_eq!(kind("meter_id", "UInt64"), Kind::Id);
        assert_eq!(kind("reading", "UInt64"), Kind::Numeric);

        for name in ["id", "ID", "order_id", "area_uid", "device_uuid"] {
            assert_eq!(kind(name, "UInt64"), Kind::Id, "{name}");
        }
    }

    #[test]
    fn a_word_that_merely_ends_in_those_letters_is_not_one() {
        // The careless version of this rule matches a suffix and takes these
        // with it. They are quantities, and their sums are real.
        for name in ["valid", "pyramid", "overbid", "solid", "squid"] {
            assert_eq!(kind(name, "UInt32"), Kind::Numeric, "{name}");
        }
    }

    #[test]
    fn an_identifier_that_is_text_stays_text() {
        // Deliberate, and the thing somebody will one day try to "fix". A kind
        // says what may be asked, not what a column means: there is no
        // arithmetic on a string to withhold, and `like` on a device id is a
        // question people really ask.
        assert_eq!(kind("device_id", "String"), Kind::Text);
        assert_eq!(kind("device_id", "LowCardinality(String)"), Kind::Text);
        assert!(shape::ops_for("String").contains(&"like"));
    }

    #[test]
    fn a_uuid_is_an_identifier_whatever_it_is_called() {
        // No arithmetic to withhold, and no reason to offer `like` on it.
        assert_eq!(kind("anything_at_all", "UUID"), Kind::Id);
        assert_eq!(kind("total", "Nullable(UUID)"), Kind::Id);
    }

    #[test]
    fn the_remaining_kinds_come_from_the_type_alone() {
        assert_eq!(kind("ts", "DateTime64(3)"), Kind::Time);
        assert_eq!(kind("day", "Date"), Kind::Time);
        assert_eq!(kind("live", "Bool"), Kind::Bool);
        assert_eq!(kind("city", "String"), Kind::Text);
        assert_eq!(kind("city", "LowCardinality(String)"), Kind::Text);
        // An enum is read by its labels, so it is text.
        assert_eq!(kind("state", "Enum8('a' = 1, 'b' = 2)"), Kind::Text);
        // An address identifies a machine; it does not measure one.
        assert_eq!(kind("client", "IPv4"), Kind::Id);
    }

    #[test]
    fn one_column_holding_many_values_can_only_be_returned() {
        for ty in [
            "Array(String)",
            "Map(String, UInt64)",
            "Tuple(UInt8, UInt8)",
        ] {
            let kind = kind("xs", ty);
            assert_eq!(kind, Kind::Unsupported, "{ty}");
            assert!(!kind.groups(), "{ty}");
            assert!(kind.aggregations().is_empty(), "{ty}");
        }
    }

    #[test]
    fn arithmetic_is_offered_on_quantities_and_nowhere_else() {
        assert!(Kind::Numeric.accepts(Agg::Sum));
        assert!(Kind::Numeric.accepts(Agg::Avg));

        for kind in [Kind::Id, Kind::Time, Kind::Text, Kind::Bool] {
            assert!(!kind.accepts(Agg::Sum), "{kind:?}");
            assert!(!kind.accepts(Agg::Avg), "{kind:?}");
            // But counting rows never asks anything of the values.
            assert!(kind.accepts(Agg::Count), "{kind:?}");
        }

        // An order without arithmetic: the earliest and the latest are exactly
        // what a timestamp is asked for.
        assert!(Kind::Time.accepts(Agg::Min));
        assert!(!Kind::Bool.accepts(Agg::Min));
    }

    fn metric(agg: Agg, column: Option<&str>) -> shape::Metric {
        shape::Metric {
            aggregation: agg,
            column: column.map(str::to_string),
            alias: "m".into(),
        }
    }

    fn asking(dimensions: &[&str], metrics: Vec<shape::Metric>) -> Aggregate {
        Aggregate {
            buckets: Vec::new(),
            dimensions: dimensions.iter().map(|d| (*d).to_string()).collect(),
            metrics,
            having: None,
        }
    }

    #[test]
    fn summing_an_identifier_is_refused_and_told_what_it_could_have_asked() {
        // The whole reason this module exists: `sum(meter_id)` compiles, runs,
        // and returns a number that means nothing.
        let columns = [col("meter_id", "UInt64"), col("reading", "UInt64")];

        let err = permits(
            &columns,
            &asking(&[], vec![metric(Agg::Sum, Some("meter_id"))]),
        )
        .expect_err("summing an id");
        assert!(err.contains("does not take `sum`"), "{err}");
        // Told what it does take, because a caller given only "no" tries the
        // next one on the list.
        assert!(err.contains("distinct_count"), "{err}");

        // The same type, the other column, and it is fine.
        permits(
            &columns,
            &asking(&[], vec![metric(Agg::Sum, Some("reading"))]),
        )
        .expect("summing a quantity");
    }

    #[test]
    fn counting_rows_asks_nothing_of_any_column() {
        let columns = [col("tags", "Array(String)")];
        // No column named, so there is nothing to permit or refuse.
        permits(&columns, &asking(&[], vec![metric(Agg::Count, None)])).expect("count()");
    }

    #[test]
    fn a_column_holding_many_values_can_neither_group_nor_measure() {
        let columns = [col("tags", "Array(String)")];

        let err = permits(&columns, &asking(&["tags"], vec![])).expect_err("grouping an array");
        assert!(err.contains("many values at once"), "{err}");

        let err = permits(&columns, &asking(&[], vec![metric(Agg::Max, Some("tags"))]))
            .expect_err("measuring an array");
        assert!(err.contains("nothing can be measured"), "{err}");
    }

    #[test]
    fn a_column_that_is_not_there_is_left_to_whoever_can_list_them() {
        // `shape` knows every column and prints them; repeating a worse version
        // of that message here would just get there first.
        let columns = [col("n", "UInt64")];
        permits(
            &columns,
            &asking(&["nope"], vec![metric(Agg::Sum, Some("also_nope"))]),
        )
        .expect("deferred, not decided");
    }

    #[test]
    fn a_timestamp_has_bounds_but_no_arithmetic() {
        let columns = [col("ts", "DateTime")];
        permits(&columns, &asking(&[], vec![metric(Agg::Max, Some("ts"))])).expect("max(ts)");
        let err = permits(&columns, &asking(&[], vec![metric(Agg::Avg, Some("ts"))]))
            .expect_err("avg of a time");
        assert!(err.contains("does not take `avg`"), "{err}");
    }

    #[test]
    fn a_dataset_counts_what_it_can_and_cannot_do() {
        let inventory = describe(
            "analytics.events",
            &[
                col("id", "UUID"),
                col("ts", "DateTime"),
                col("city", "String"),
                col("amount", "Float64"),
                col("tags", "Array(String)"),
            ],
        );
        assert_eq!(inventory.dataset, "analytics.events");
        assert_eq!(inventory.groupable, 4);
        // Everything but the array can carry at least a `count`.
        assert_eq!(inventory.measurable, 4);
        // And the one that cannot says so, with its own count, rather than
        // being quietly dropped from a list somebody is reading to find it.
        let note = inventory.note.expect("a note about the array");
        assert!(note.contains("1 of 5"), "{note}");
        // One column, so the sentence is about one column.
        assert!(note.contains("holds"), "{note}");
        assert!(note.contains("it is returned"), "{note}");
    }

    #[test]
    fn a_dataset_that_can_do_everything_says_nothing() {
        let inventory = describe("a.b", &[col("n", "UInt8"), col("city", "String")]);
        assert!(inventory.note.is_none());
        assert_eq!(inventory.groupable, 2);
    }

    #[test]
    fn nullability_is_reported_because_it_changes_what_can_be_asked() {
        // `isnull` is offered on a Nullable column and nowhere else, so a
        // caller reading the inventory needs to see which.
        let inventory = describe("a.b", &[col("city", "Nullable(String)"), col("n", "UInt8")]);
        assert!(inventory.columns[0].nullable);
        assert!(!inventory.columns[1].nullable);
    }
}
