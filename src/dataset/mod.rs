//! A question asked of a dataset, carried in a body.
//!
//! A **dataset** is a table or a view — nothing is registered, declared or
//! published to make one. Which tables exist for a given caller is a question
//! ClickHouse already answers, through grants and row policies, and asking it
//! again here would only produce a second answer that can disagree with the
//! first. So this module never decides whether a name may be read: it decides
//! whether the *question* is one Flint is willing to build a statement for, and
//! the server decides the rest.
//!
//! What the body buys over the query string is exactly one thing: a filter that
//! is a tree. `city=eq.Oslo&n=gt.5` is a conjunction and there is nowhere in a
//! URL to put an `OR`, so every question that needs one has, until now, had to
//! be published as a statement by somebody with the rights to publish. That is
//! the whole reason this exists, and it is worth being precise that it is the
//! *only* new expressive power here — the operators, the projection, the order
//! and the paging are `published::shape`'s, unchanged, rendered by the same
//! code through the same guards.
//!
//! Those guards, restated because they are what makes an open surface safe:
//! every column a caller names is matched against what the statement really
//! returns — asked of ClickHouse with `DESCRIBE`, never parsed out of SQL — and
//! every value travels as a bound `{name:Type}` parameter. Nothing a caller
//! types is concatenated into a statement, and a column that is not one of the
//! dataset's is refused by name rather than sent on.

pub mod inventory;
pub mod openapi;
pub mod time;

use serde::Deserialize;

use crate::published::shape::{self, Agg, Aggregate, Filter, Metric, Op, Predicate, Shape, Sort};
use crate::published::{cursor, Format};

/// A dataset, as the caller named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Name {
    /// `None` means the database this Flint is pointed at, which is what an
    /// unqualified name has always meant everywhere else in the product.
    pub database: Option<String>,
    pub table: String,
}

impl Name {
    /// The statement a dataset is, before anything is asked of it.
    ///
    /// Identifiers are quoted rather than pattern-matched. A name Flint cannot
    /// quote does not exist, and a name it can quote but the caller may not
    /// read is refused by ClickHouse — with a grant error, which is the honest
    /// answer and the one that stays right when the grants change under us.
    pub fn statement(&self) -> String {
        match &self.database {
            Some(database) => format!(
                "SELECT * FROM {}.{}",
                shape::quote_ident(database),
                shape::quote_ident(&self.table)
            ),
            None => format!("SELECT * FROM {}", shape::quote_ident(&self.table)),
        }
    }

    /// How the dataset is named back to the caller and in `log_comment`.
    pub fn label(&self) -> String {
        match &self.database {
            Some(database) => format!("{database}.{}", self.table),
            None => self.table.clone(),
        }
    }
}

/// `analytics.events`, or `events` for the deployment's own database.
///
/// Split on the *first* dot, because a database name cannot contain one and a
/// table name can. An empty half is refused rather than quietly dropped: the
/// caller who sent `analytics.` meant to send a table.
pub fn parse_name(raw: &str) -> Result<Name, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("name a dataset — a table or a view, as `database.table`".into());
    }
    match raw.split_once('.') {
        None => Ok(Name {
            database: None,
            table: raw.to_string(),
        }),
        Some((database, table)) if !database.is_empty() && !table.is_empty() => Ok(Name {
            database: Some(database.to_string()),
            table: table.to_string(),
        }),
        Some(_) => Err(format!(
            "`{raw}` is half a name — write `database.table`, or just `table`"
        )),
    }
}

/// One node of a filter, as JSON writes it.
///
/// Four shapes in one struct rather than an untagged enum, so that a body which
/// is *nearly* one of them is told which one it nearly was. Serde's untagged
/// error for this is "data did not match any variant", which is true and
/// useless.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    #[serde(default)]
    pub all: Option<Vec<Node>>,
    #[serde(default)]
    pub any: Option<Vec<Node>>,
    #[serde(default)]
    pub not: Option<Box<Node>>,
    #[serde(default)]
    pub column: Option<String>,
    #[serde(default)]
    pub op: Option<String>,
    /// One value, for the comparisons that take one.
    ///
    /// Doubly optional, and it earns the awkwardness: serde folds an explicit
    /// `"value": null` into the same `None` as a field that was never sent, and
    /// those two are different mistakes. One is a caller who wanted `isnull`;
    /// the other is a caller who forgot the value. Telling them apart is the
    /// difference between naming the operator they meant and answering "was
    /// given 0 values", which is true and helps nobody.
    #[serde(default, deserialize_with = "sent")]
    pub value: Option<Option<serde_json::Value>>,
    /// Several, for `in` and `nin`. A body can carry a list of four thousand
    /// identifiers, which is the other thing a query string cannot do.
    #[serde(default)]
    pub values: Option<Vec<serde_json::Value>>,
}

/// Present-but-null, kept distinct from absent. See [`Node::value`].
fn sent<'de, D>(deserializer: D) -> Result<Option<Option<serde_json::Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<serde_json::Value>::deserialize(deserializer).map(Some)
}

impl Node {
    /// Which of the four shapes this is, refusing anything that is more than one
    /// of them.
    fn into_predicate(self) -> Result<Predicate, String> {
        let groups = usize::from(self.all.is_some())
            + usize::from(self.any.is_some())
            + usize::from(self.not.is_some());
        let comparison = self.column.is_some() || self.op.is_some();

        if groups + usize::from(comparison) > 1 {
            return Err(
                "a filter is one of `all`, `any`, `not` or a comparison — not several at once"
                    .into(),
            );
        }

        if let Some(parts) = self.all {
            return Ok(Predicate::All(collect(parts)?));
        }
        if let Some(parts) = self.any {
            return Ok(Predicate::Any(collect(parts)?));
        }
        if let Some(inner) = self.not {
            return Ok(Predicate::Not(Box::new(inner.into_predicate()?)));
        }
        if !comparison {
            return Err("this filter says nothing — give it `all`, `any`, `not`, \
                        or a `column` and an `op`"
                .into());
        }

        let column = self
            .column
            .filter(|c| !c.trim().is_empty())
            .ok_or("a comparison needs the `column` it compares")?;
        let keyword = self.op.ok_or_else(|| {
            format!("`{column}` has no `op` — say how to compare it, e.g. \"eq\"")
        })?;
        let op = Op::from_keyword(&keyword).ok_or_else(|| {
            format!(
                "`{keyword}` is not an operator; use one of {}",
                Op::keywords().join(", ")
            )
        })?;

        // `value` and `values` are the same field asked twice, and the operator
        // decides which one was the right question. Taking both would leave the
        // caller guessing which one was used.
        // Absent stays absent; an explicit null becomes a value, so that
        // `scalar` can say which operator was actually meant.
        let one = self.value.map(|v| v.unwrap_or(serde_json::Value::Null));
        let raw = match (one, self.values) {
            (Some(one), None) => vec![one],
            (None, Some(many)) => many,
            (None, None) => Vec::new(),
            (Some(_), Some(_)) => {
                return Err(format!(
                    "`{column}` was given both `value` and `values` — send whichever one \
                     `{keyword}` takes"
                ))
            }
        };

        let values = raw
            .into_iter()
            .map(|v| scalar(&column, v))
            .collect::<Result<Vec<_>, _>>()?;

        // Arity, checked here rather than left to produce a confusing statement:
        // `in` with nothing in it matches no rows, which is a question nobody
        // asks on purpose, and `eq` with three values is two values ignored.
        if op.takes_value() {
            if op.takes_list() {
                if values.is_empty() {
                    return Err(format!(
                        "`{column} {keyword}` was given no values, so it can match nothing"
                    ));
                }
            } else if values.len() != 1 {
                return Err(format!(
                    "`{column} {keyword}` compares to exactly one value, and was given {}",
                    values.len()
                ));
            }
        } else if !values.is_empty() {
            return Err(format!(
                "`{keyword}` asks whether `{column}` is null — it takes no value"
            ));
        }

        Ok(Predicate::Cmp(Filter { column, op, values }))
    }
}

fn collect(parts: Vec<Node>) -> Result<Vec<Predicate>, String> {
    parts.into_iter().map(Node::into_predicate).collect()
}

/// A JSON value as the binder wants it: a string, whatever it arrived as.
///
/// Numbers and booleans are accepted and stringified rather than refused,
/// because `{"column":"n","op":"gt","value":5}` is what anyone writes and
/// insisting on `"5"` would be pedantry with a 400 attached. `null` is refused,
/// though — comparing to null is never what the caller meant, and `isnull` is
/// the operator that asks the question they had.
fn scalar(column: &str, value: serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        serde_json::Value::Null => Err(format!(
            "`{column}` was compared to null — use the `isnull` or `notnull` operator"
        )),
        _ => Err(format!(
            "`{column}` was compared to an object or an array; a filter compares to values"
        )),
    }
}

/// One metric, as JSON writes it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricSpec {
    pub aggregation: String,
    /// Absent only for `count`, which counts rows rather than values.
    #[serde(default)]
    pub column: Option<String>,
    /// What to call it in the answer. Absent means Flint names it.
    #[serde(default, rename = "as")]
    pub alias: Option<String>,
}

impl MetricSpec {
    /// The name a metric arrives under when the caller did not choose one.
    ///
    /// `avg` of `temperature` becomes `avg_temperature`, and a bare `count`
    /// stays `count`. Predictable rather than clever: a caller writing a chart
    /// against this has to be able to know the key without sending the request
    /// first.
    fn default_alias(&self, agg: Agg) -> String {
        match &self.column {
            Some(column) => format!("{}_{column}", agg.keyword()),
            None => agg.keyword().to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

/// Everything a caller may ask of a dataset.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub dataset: String,
    /// Empty means every column the dataset has. Refused alongside
    /// `dimensions`/`metrics`, which are the other way of saying what comes
    /// back.
    #[serde(default)]
    pub select: Vec<String>,
    /// Columns to group by. With `metrics`, this is what turns a read into an
    /// aggregate.
    #[serde(default)]
    pub dimensions: Vec<String>,
    #[serde(default)]
    pub metrics: Vec<MetricSpec>,
    /// A filter on what was computed, applied after the grouping. The same
    /// shape a `filter` is, over the names the answer returns rather than the
    /// dataset's own columns.
    #[serde(default)]
    pub having: Option<Node>,
    /// When. See `dataset::time` — a window, a granularity, or both.
    #[serde(default)]
    pub time: Option<time::TimeSpecs>,
    /// Where the days begin, for everything in `time` and every date in the
    /// answer. Empty is the server's own zone.
    ///
    /// The caller's to choose here, which is the opposite of a published
    /// endpoint — and the difference is who wrote the question. An endpoint is
    /// a fixed address somebody else published, so its buckets belong to it:
    /// two callers must see the same days or neither can reconcile a figure
    /// with the other. This is a document the caller writes on every call, so
    /// "last 7 days, in my days" is a legitimate thing to ask, and the answer
    /// says which zone it used so a stored result still means something a
    /// month later.
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub filter: Option<Node>,
    #[serde(default)]
    pub order: Vec<SortSpec>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub count: bool,
    #[serde(default)]
    pub format: Option<String>,
    /// Build the statement and answer with it, without running it.
    ///
    /// For a builder that shows its work. A page that renders SQL only after
    /// the query returns cannot show you what it is about to ask, and a page
    /// that renders it locally is a second implementation of this whole
    /// language — which is how the two drifted apart in the first place.
    ///
    /// It still describes the dataset, because a column that is not there is
    /// still a mistake worth naming before somebody presses run.
    #[serde(default)]
    pub explain: bool,
    /// The handle this read will be known by, so the caller can stop it.
    ///
    /// The SQL editor has always been able to cancel a query it started,
    /// because `/api/run` lets the caller mint the id ClickHouse files the
    /// query under and `KILL QUERY` matches on it. A question asked through
    /// this document is the same read against the same server, and a form whose
    /// Run button cannot be taken back is a form that asks people to be sure
    /// before they press it — so the same handle is offered here.
    ///
    /// Optional, because a caller with nothing to cancel with should not have
    /// to invent one. It rides on the page read alone: the `count` beside it is
    /// a second statement, and ClickHouse refuses two live queries under one id.
    #[serde(default)]
    pub query_id: Option<String>,
}

/// What the handler needs, once the body has been read as a question.
#[derive(Debug)]
pub struct Asked {
    pub name: Name,
    pub shape: Shape,
    pub format: Format,
    /// Answer with the statement rather than with rows.
    pub explain: bool,
    /// Held back until the dataset has described itself: which column a window
    /// is on can depend on what columns there are.
    pub time: Vec<time::Plan>,
    /// The zone the statement runs in, or empty for the server's own.
    pub timezone: String,
}

impl Request {
    /// The `GROUP BY` this body asks for, if it asks for one.
    ///
    /// Only the shape of the request is settled here — that an aggregation
    /// exists, that it takes the column it was given, that two metrics do not
    /// arrive under one name. Whether a *particular* column may be summed is
    /// a question about the data, and it is asked in `inventory` once the
    /// dataset has been described.
    fn aggregate(&mut self) -> Result<Option<Aggregate>, String> {
        let dimensions = std::mem::take(&mut self.dimensions);
        let specs = std::mem::take(&mut self.metrics);
        let having = self.having.take();
        if dimensions.is_empty() && specs.is_empty() {
            // `having` filters what was computed, and nothing was. Said rather
            // than ignored: a request carrying one meant to aggregate.
            if having.is_some() {
                return Err(
                    "`having` filters what an answer computed, and this one computes \
                     nothing — give it `dimensions` or `metrics`, or use `filter`, which \
                     narrows the rows instead"
                        .into(),
                );
            }
            return Ok(None);
        }

        let mut metrics = Vec::with_capacity(specs.len());
        for spec in &specs {
            let agg = Agg::from_keyword(&spec.aggregation).ok_or_else(|| {
                format!(
                    "`{}` is not an aggregation; use one of {}",
                    spec.aggregation,
                    Agg::keywords().join(", ")
                )
            })?;

            let column = spec.column.clone().filter(|c| !c.trim().is_empty());
            if column.is_none() && !agg.column_optional() {
                return Err(format!(
                    "`{}` needs the column it measures",
                    spec.aggregation
                ));
            }

            metrics.push(Metric {
                alias: spec
                    .alias
                    .clone()
                    .filter(|a| !a.trim().is_empty())
                    .unwrap_or_else(|| spec.default_alias(agg)),
                aggregation: agg,
                column,
            });
        }

        // Every name in the answer has to be distinct, or a caller reading it
        // by key gets one of two values and no way to know which. Dimensions
        // are in the same namespace: grouping by `count` and counting into
        // `count` is the collision that would otherwise be silent.
        let mut seen: Vec<&str> = Vec::new();
        for name in dimensions
            .iter()
            .map(String::as_str)
            .chain(metrics.iter().map(|m| m.alias.as_str()))
        {
            if seen.contains(&name) {
                return Err(format!(
                    "two things in this answer would both be called `{name}` — name one of \
                     them with `as`"
                ));
            }
            seen.push(name);
        }

        Ok(Some(Aggregate {
            // Filled in by the time plans once the dataset has described itself
            // and the time columns are known.
            buckets: Vec::new(),
            dimensions,
            metrics,
            having: having.map(Node::into_predicate).transpose()?,
        }))
    }

    /// Read the body as a question, clamped to what this deployment serves.
    ///
    /// `cap` is a page size, exactly as it is for a published statement: the
    /// most rows one response may carry, never a statement about how many rows
    /// exist. A caller who asks for more is served the cap and *told* so
    /// through `limit_asked`, rather than left to infer that the data ended.
    pub fn into_asked(mut self, cap: u64) -> Result<Asked, String> {
        let name = parse_name(&self.dataset)?;
        let format = Format::parse(self.format.as_deref())?;

        // Zero is refused rather than clamped, and the reason is one layer down:
        // `QueryOptions::max_rows` reads `0` as *no cap at all*. The floor in
        // the clamp below is therefore load-bearing, not tidiness — a zero
        // threaded through it would take the row cap off the statement. And a
        // caller who sends one is almost always after the total, which has its
        // own field.
        if self.limit == Some(0) {
            return Err(
                "`limit: 0` asks for no rows. Ask for a total with `count`, or a limit of \
                 at least one row"
                    .into(),
            );
        }

        let asked = self.limit;
        let limit = asked.map(|n| n.clamp(1, cap));
        let limit_asked = match (asked, limit) {
            (Some(asked), Some(served)) if asked != served => Some(asked),
            _ => None,
        };

        let aggregate = self.aggregate()?;
        let plans = self
            .time
            .take()
            .map(time::TimeSpecs::into_plans)
            .transpose()?
            .unwrap_or_default();

        // Two ways to say what comes back, and answering both would mean
        // choosing one without saying which. A granularity counts as one of
        // them: it groups, whether or not anything is measured over it.
        let groups = aggregate.is_some() || plans.iter().any(time::Plan::buckets);

        // A comparison compares *measurements*. Two windows of raw rows is two
        // pages of rows with a label on them, which is not a comparison and not
        // what anyone means by one — so it is refused rather than served as
        // something that looks like an answer.
        let measures = aggregate.as_ref().is_some_and(|a| !a.metrics.is_empty());
        if plans.iter().any(time::Plan::compares) && !measures {
            return Err("a comparison compares measurements — give it at least one metric".into());
        }
        if groups && !self.select.is_empty() {
            return Err(
                "`select` names columns and `dimensions`/`metrics` compute them — send one \
                 or the other"
                    .into(),
            );
        }

        // These two are checked on the cursor being *there*, before it is
        // decoded, because that ordering is what decides which complaint a
        // caller reads. Sending a cursor to an aggregate is a misunderstanding
        // worth naming; being told first that the cursor does not parse would
        // send somebody looking at the wrong half of their request.
        if self.cursor.is_some() {
            if groups {
                // A cursor walks by the ordering values of the last row. An
                // aggregated row's values are computed rather than stored, so
                // there is nothing to carry on from — said here rather than
                // returned as a page that silently never advances.
                return Err(
                    "an aggregated answer cannot be paged by cursor, because its rows are \
                     computed rather than stored — use `offset`"
                        .into(),
                );
            }
            // A cursor and an offset are two answers to "where does this page
            // start", and honouring both would walk from a place the caller
            // never asked about.
            if self.offset > 0 {
                return Err(
                    "this page was given both a `cursor` and an `offset` — a cursor already \
                     says where to carry on from"
                        .into(),
                );
            }
        }

        let cursor = self.cursor.as_deref().map(cursor::decode).transpose()?;

        let shape = Shape {
            select: self.select,
            aggregate,
            // Same: a window needs its time column, which needs the dataset.
            windows: Vec::new(),
            compare: None,
            filters: Vec::new(),
            tree: self.filter.map(Node::into_predicate).transpose()?,
            order: self
                .order
                .into_iter()
                .map(|s| Sort {
                    column: s.column,
                    desc: s.desc,
                })
                .collect(),
            limit,
            limit_asked,
            offset: self.offset,
            cursor,
            count: self.count,
        };

        // Refused rather than ignored where it could do nothing. A zone on a
        // query with no date in it is a caller who believes they have placed
        // their buckets somewhere, and silence would leave them believing it.
        if !self.timezone.is_empty() && plans.is_empty() && !groups {
            return Err(format!(
                "`timezone: {}` has nothing to place: this query asks for no time window \
                 and no time bucket, so no day boundary is being drawn. Add a `time` \
                 window or granularity, or drop the timezone.",
                self.timezone
            ));
        }

        Ok(Asked {
            name,
            shape,
            format,
            explain: self.explain,
            time: plans,
            timezone: self.timezone,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(json: &str) -> Result<Asked, String> {
        serde_json::from_str::<Request>(json)
            .map_err(|e| e.to_string())?
            .into_asked(1000)
    }

    #[test]
    fn a_timezone_needs_something_to_place() {
        // A zone on a query that draws no day boundary is a caller who believes
        // they have moved their buckets. Silence would leave them believing it,
        // so it is refused — and the refusal says what would make it mean
        // something rather than only that it does not.
        let refused = ask(r#"{"dataset":"db.t","select":["a"],"timezone":"Pacific/Auckland"}"#)
            .expect_err("a zone with nothing to place must be refused");
        assert!(refused.contains("nothing to place"), "{refused}");
        assert!(refused.contains("granularity"), "{refused}");
    }

    #[test]
    fn a_timezone_is_kept_where_there_is_a_boundary_to_draw() {
        // Both halves of "something to place": a window, whose edges are
        // midnights, and a bucket, whose walls are. Either one alone is enough.
        for body in [
            r#"{"dataset":"db.t","time":{"column":"ts","period":"yesterday"},"timezone":"UTC"}"#,
            r#"{"dataset":"db.t","time":{"column":"ts","granularity":"day"},
                "metrics":[{"aggregation":"count","column":"a","as":"n"}],"timezone":"UTC"}"#,
        ] {
            let asked = ask(body).expect("a zone with a boundary to draw is kept");
            assert_eq!(asked.timezone, "UTC", "{body}");
        }
    }

    fn tree(json: &str) -> Result<Predicate, String> {
        ask(json)?.shape.tree.ok_or("no filter".to_string())
    }

    #[test]
    fn a_dataset_is_a_table_or_a_view_named_two_ways() {
        assert_eq!(
            parse_name("analytics.events"),
            Ok(Name {
                database: Some("analytics".into()),
                table: "events".into()
            })
        );
        // Unqualified means the deployment's own database, as it does
        // everywhere else in the product.
        assert_eq!(
            parse_name("events"),
            Ok(Name {
                database: None,
                table: "events".into()
            })
        );
        // A table name may contain a dot; a database name may not — so the
        // first one is the separator.
        assert_eq!(
            parse_name("analytics.a.b"),
            Ok(Name {
                database: Some("analytics".into()),
                table: "a.b".into()
            })
        );
    }

    #[test]
    fn half_a_name_is_refused_rather_than_completed() {
        for raw in ["analytics.", ".events", "", "   "] {
            assert!(parse_name(raw).is_err(), "{raw} was accepted");
        }
    }

    #[test]
    fn an_identifier_cannot_leave_its_quotes() {
        // The one thing standing between a dataset name and a statement. A
        // backtick that closed the quoting would put the rest of the name into
        // the statement as SQL.
        let name = parse_name("db.ev`il").expect("a name");
        let sql = name.statement();
        assert_eq!(sql, "SELECT * FROM `db`.`ev\\`il`");
    }

    #[test]
    fn a_filter_tree_is_what_the_body_is_for() {
        // The question a query string cannot ask: an OR.
        let parsed = tree(
            r#"{"dataset":"a.b","filter":{"any":[
                 {"column":"city","op":"eq","value":"Oslo"},
                 {"column":"n","op":"gt","value":5}
               ]}}"#,
        )
        .expect("a tree");
        let Predicate::Any(parts) = parsed else {
            panic!("expected any, got {parsed:?}");
        };
        assert_eq!(parts.len(), 2);
        assert_eq!(
            parts[0],
            Predicate::Cmp(Filter {
                column: "city".into(),
                op: Op::Eq,
                values: vec!["Oslo".into()],
            })
        );
        // A number stays a number to whoever wrote it, and becomes a string on
        // the way to the binder, which is where types are decided anyway.
        assert_eq!(
            parts[1],
            Predicate::Cmp(Filter {
                column: "n".into(),
                op: Op::Gt,
                values: vec!["5".into()],
            })
        );
    }

    #[test]
    fn a_group_may_hold_a_group() {
        let parsed = tree(
            r#"{"dataset":"a.b","filter":{"all":[
                 {"column":"live","op":"eq","value":true},
                 {"not":{"any":[{"column":"city","op":"in","values":["Oslo","Bergen"]}]}}
               ]}}"#,
        )
        .expect("a tree");
        let Predicate::All(parts) = parsed else {
            panic!("expected all");
        };
        assert!(matches!(parts[1], Predicate::Not(_)));
    }

    #[test]
    fn a_filter_that_is_two_things_at_once_is_refused() {
        let err = tree(
            r#"{"dataset":"a.b","filter":{"all":[{"column":"n","op":"gt","value":1}],
                 "column":"city","op":"eq","value":"Oslo"}}"#,
        )
        .expect_err("both a group and a comparison");
        assert!(err.contains("not several at once"), "{err}");
    }

    #[test]
    fn an_operator_is_told_how_many_values_it_takes() {
        // `eq` with a list is a caller who meant `in`, and answering it with the
        // first value would be answering a different question.
        let err = tree(r#"{"dataset":"a.b","filter":{"column":"n","op":"eq","values":[1,2]}}"#)
            .expect_err("two values for eq");
        assert!(err.contains("exactly one value"), "{err}");

        // `in` with nothing in it matches nothing, which nobody asks on purpose.
        let err = tree(r#"{"dataset":"a.b","filter":{"column":"n","op":"in","values":[]}}"#)
            .expect_err("an empty in");
        assert!(err.contains("match nothing"), "{err}");

        // `isnull` asks about the column, not about a value.
        let err = tree(r#"{"dataset":"a.b","filter":{"column":"n","op":"isnull","value":1}}"#)
            .expect_err("a value for isnull");
        assert!(err.contains("takes no value"), "{err}");
    }

    #[test]
    fn comparing_to_null_names_the_operator_that_was_meant() {
        let err = tree(r#"{"dataset":"a.b","filter":{"column":"n","op":"eq","value":null}}"#)
            .expect_err("null");
        assert!(err.contains("isnull"), "{err}");
    }

    #[test]
    fn an_unknown_operator_lists_the_ones_there_are() {
        let err = tree(r#"{"dataset":"a.b","filter":{"column":"n","op":"between","value":1}}"#)
            .expect_err("between");
        assert!(err.contains("not an operator"), "{err}");
        assert!(err.contains("eq"), "{err}");
    }

    fn agg(json: &str) -> Result<Aggregate, String> {
        ask(json)?
            .shape
            .aggregate
            .ok_or("not aggregated".to_string())
    }

    #[test]
    fn dimensions_and_metrics_turn_a_read_into_an_aggregate() {
        let a = agg(r#"{"dataset":"a.b","dimensions":["city"],
                "metrics":[{"aggregation":"count"},
                           {"aggregation":"avg","column":"temperature"}]}"#)
        .expect("an aggregate");
        assert_eq!(a.dimensions, ["city"]);
        // Predictable names, so a caller can write the chart before sending the
        // request: a bare count stays `count`, everything else is agg_column.
        assert_eq!(a.metrics[0].alias, "count");
        assert_eq!(a.metrics[1].alias, "avg_temperature");
        assert_eq!(a.output_names(), ["city", "count", "avg_temperature"]);
    }

    #[test]
    fn either_half_alone_is_still_a_question() {
        // "Which cities are there" — no metric.
        assert!(agg(r#"{"dataset":"a.b","dimensions":["city"]}"#).is_ok());
        // "How many altogether" — no dimension.
        assert!(agg(r#"{"dataset":"a.b","metrics":[{"aggregation":"count"}]}"#).is_ok());
        // And neither is not an aggregate at all.
        assert!(ask(r#"{"dataset":"a.b"}"#)
            .expect("ok")
            .shape
            .aggregate
            .is_none());
    }

    #[test]
    fn a_caller_may_name_a_metric_and_must_where_two_would_collide() {
        let a =
            agg(r#"{"dataset":"a.b","metrics":[{"aggregation":"sum","column":"n","as":"total"}]}"#)
                .expect("an aggregate");
        assert_eq!(a.metrics[0].alias, "total");

        // Two metrics under one name: a caller reading by key would get one of
        // the two values with no way to tell which.
        let err = agg(
            r#"{"dataset":"a.b","metrics":[{"aggregation":"sum","column":"n"},
                                            {"aggregation":"sum","column":"n"}]}"#,
        )
        .expect_err("a collision");
        assert!(err.contains("sum_n"), "{err}");
        assert!(err.contains("`as`"), "{err}");

        // Dimensions share the namespace, because the answer has one.
        let err =
            agg(r#"{"dataset":"a.b","dimensions":["count"],"metrics":[{"aggregation":"count"}]}"#)
                .expect_err("a collision with a dimension");
        assert!(err.contains("`count`"), "{err}");
    }

    #[test]
    fn an_aggregation_is_named_from_a_closed_set_and_needs_its_column() {
        let err = agg(r#"{"dataset":"a.b","metrics":[{"aggregation":"stddev","column":"n"}]}"#)
            .expect_err("not an aggregation");
        assert!(err.contains("not an aggregation"), "{err}");
        assert!(err.contains("median"), "{err}");

        // `count` is the only one that means anything with no column.
        let err =
            agg(r#"{"dataset":"a.b","metrics":[{"aggregation":"avg"}]}"#).expect_err("no column");
        assert!(err.contains("needs the column"), "{err}");
        assert!(agg(r#"{"dataset":"a.b","metrics":[{"aggregation":"count"}]}"#).is_ok());
    }

    #[test]
    fn naming_columns_and_computing_them_are_two_different_requests() {
        let err =
            ask(r#"{"dataset":"a.b","select":["city"],"dimensions":["city"]}"#).expect_err("both");
        assert!(
            err.contains("one \nor the other") || err.contains("one or the other"),
            "{err}"
        );
    }

    #[test]
    fn an_aggregated_answer_has_no_row_to_carry_on_from() {
        // A cursor is the ordering values of the last row; an aggregated row's
        // values are computed, so there is nothing to resume at. Better said
        // than returned as a page that never advances.
        let err = ask(r#"{"dataset":"a.b","dimensions":["city"],"cursor":"x"}"#)
            .expect_err("a cursor on an aggregate");
        assert!(err.contains("computed rather than stored"), "{err}");
    }

    #[test]
    fn having_filters_what_was_computed() {
        let a = agg(r#"{"dataset":"a.b","dimensions":["city"],
                "metrics":[{"aggregation":"count"}],
                "having":{"column":"count","op":"gt","value":1000}}"#)
        .expect("an aggregate");
        assert!(matches!(a.having, Some(Predicate::Cmp(_))));
    }

    #[test]
    fn having_needs_something_to_have_been_computed() {
        // A request carrying one meant to aggregate, so ignoring it would
        // answer a different question quietly.
        let err = ask(r#"{"dataset":"a.b","having":{"column":"n","op":"gt","value":1}}"#)
            .expect_err("nothing computed");
        assert!(
            err.contains("computes\nnothing") || err.contains("computes nothing"),
            "{err}"
        );
        assert!(err.contains("`filter`"), "{err}");
    }

    #[test]
    fn the_percentiles_the_builder_has_are_ones_the_server_has_too() {
        // Converging the two query languages is only honest if nothing is lost
        // on the way, and these were the two that would have been.
        for keyword in ["p95", "p99", "distinct_count_approx"] {
            let a = agg(&format!(
                r#"{{"dataset":"a.b","metrics":[{{"aggregation":"{keyword}","column":"n"}}]}}"#
            ))
            .unwrap_or_else(|e| panic!("{keyword}: {e}"));
            assert_eq!(a.metrics[0].alias, format!("{keyword}_n"));
        }
    }

    #[test]
    fn an_exact_distinct_count_and_an_estimate_are_different_words() {
        // Same concept, two answers, so two names — a caller reading
        // "distinct customers" must not be handed an estimate nobody mentioned,
        // and a caller who wants the cheap one has to be able to say so.
        let exact =
            agg(r#"{"dataset":"a.b","metrics":[{"aggregation":"distinct_count","column":"c"}]}"#)
                .unwrap();
        let approx = agg(
            r#"{"dataset":"a.b","metrics":[{"aggregation":"distinct_count_approx","column":"c"}]}"#,
        )
        .unwrap();
        assert_ne!(exact.metrics[0].aggregation, approx.metrics[0].aggregation);
    }

    #[test]
    fn a_limit_past_the_cap_is_served_smaller_and_says_so() {
        let asked = ask(r#"{"dataset":"a.b","limit":5000}"#).expect("a request");
        assert_eq!(asked.shape.limit, Some(1000));
        // The field that stops a short page reading as the end of the data.
        assert_eq!(asked.shape.limit_asked, Some(5000));

        let asked = ask(r#"{"dataset":"a.b","limit":10}"#).expect("a request");
        assert_eq!(asked.shape.limit, Some(10));
        assert_eq!(asked.shape.limit_asked, None);
    }

    #[test]
    fn a_page_of_no_rows_is_refused_rather_than_rounded_up_to_one() {
        // It used to serve one row and report `limit_asked: 0`, which was
        // honest and still not what anybody asked for. Refusing also keeps a
        // zero away from `max_rows`, where zero means *no cap*.
        let err = ask(r#"{"dataset":"a.b","limit":0}"#).expect_err("a page of nothing");
        assert!(err.contains("`count`"), "{err}");
        assert!(ask(r#"{"dataset":"a.b","limit":1}"#).is_ok());
    }

    #[test]
    fn a_cursor_and_an_offset_are_two_answers_to_one_question() {
        let err = ask(r#"{"dataset":"a.b","cursor":"x","offset":10}"#).expect_err("both");
        assert!(err.contains("cursor"), "{err}");
    }

    #[test]
    fn a_field_nobody_defined_is_a_typo_and_is_said_so() {
        // `deny_unknown_fields`, which matters more here than usual: a body is
        // typed by hand, and a silently ignored `wehre` returns the whole table
        // looking like an answer.
        let err = ask(r#"{"dataset":"a.b","wehre":{"column":"n","op":"gt","value":1}}"#)
            .expect_err("a typo");
        assert!(err.contains("wehre"), "{err}");
    }

    #[test]
    fn an_unshaped_request_still_knows_it_is_one() {
        let asked = ask(r#"{"dataset":"a.b"}"#).expect("a request");
        assert!(!asked.shape.wraps());
        assert!(!asked.shape.names_columns());
    }
}
