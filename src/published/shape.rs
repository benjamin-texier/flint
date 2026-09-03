//! What a caller may ask of a published statement, beyond its own parameters.
//!
//! A published statement answers one question. Everything here is about the
//! shape of the answer — which rows, in what order, which columns, how many at
//! a time — and none of it changes the question. That distinction is what makes
//! the surface safe to open: a filter, an order and a projection can only ever
//! *narrow* what the statement already returns, and the caller still supplies
//! values, never SQL.
//!
//! Two guards hold that line, and both are here rather than spread across the
//! handler. Identifiers are matched against the columns the statement actually
//! produces — asked of ClickHouse with `DESCRIBE`, not parsed out of the SQL —
//! so a name that is not one of them is refused by name rather than sent on.
//! Values travel as bound `{name:Type}` parameters under a prefix no declared
//! parameter uses, so nothing a caller types is ever concatenated into SQL.
//!
//! The one thing this does change is the meaning of an endpoint's row cap. It
//! is a page size now: the most rows one response may carry, not the most rows
//! that exist. An author who published a deliberately bounded extract writes
//! the `LIMIT` in the statement — the wrapper sits outside it, so that limit
//! still holds, and no caller can page past it.

use crate::clickhouse::ColumnMeta;

use super::cursor::{self, Cursor};

/// Query-string names Flint reads for itself.
///
/// A statement's own parameter wins over every one of these. Publishing
/// `WHERE ... LIMIT {limit:UInt32}` is a perfectly reasonable thing to have
/// done, and quietly stealing `limit` from such an endpoint would break callers
/// that already work. The endpoint's own documentation says which of these it
/// gave up — see `shadowed`.
pub const RESERVED: &[&str] = &[
    "token", "format", "limit", "offset", "cursor", "order", "select", "count",
    // The credential and the revision pin. Both are read before a shape is
    // parsed and neither is a column, so leaving them off this list made
    // `?v=4` a filter on a column called `v` — which answered 400 with a
    // sentence about operators, to a caller who had done nothing wrong.
    "key", "v",
];

/// The reserved names this statement claimed for itself, so the docs can say
/// so rather than describing a surface the endpoint does not have.
pub fn shadowed(declared: &[String]) -> Vec<String> {
    RESERVED
        .iter()
        .filter(|r| declared.iter().any(|d| d == *r))
        .map(|r| (*r).to_string())
        .collect()
}

/// What a caller may do to a column. A closed set: an operator that is not on
/// this list is refused by name, so there is no path from a query string to an
/// expression Flint did not write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Like,
    ILike,
    In,
    NotIn,
    IsNull,
    NotNull,
}

impl Op {
    pub const fn keyword(self) -> &'static str {
        match self {
            Op::Eq => "eq",
            Op::Ne => "ne",
            Op::Gt => "gt",
            Op::Gte => "gte",
            Op::Lt => "lt",
            Op::Lte => "lte",
            Op::Like => "like",
            Op::ILike => "ilike",
            Op::In => "in",
            Op::NotIn => "nin",
            Op::IsNull => "isnull",
            Op::NotNull => "notnull",
        }
    }

    const ALL: [Op; 12] = [
        Op::Eq,
        Op::Ne,
        Op::Gt,
        Op::Gte,
        Op::Lt,
        Op::Lte,
        Op::Like,
        Op::ILike,
        Op::In,
        Op::NotIn,
        Op::IsNull,
        Op::NotNull,
    ];

    pub fn from_keyword(word: &str) -> Option<Op> {
        Op::ALL.into_iter().find(|op| op.keyword() == word)
    }

    /// Every operator there is, for an error that names the alternatives rather
    /// than leaving somebody to find the documentation.
    pub fn keywords() -> Vec<&'static str> {
        Op::ALL.into_iter().map(Op::keyword).collect()
    }

    const fn infix(self) -> &'static str {
        match self {
            Op::Eq => "=",
            Op::Ne => "!=",
            Op::Gt => ">",
            Op::Gte => ">=",
            Op::Lt => "<",
            Op::Lte => "<=",
            Op::Like => "LIKE",
            Op::ILike => "ILIKE",
            Op::In => "IN",
            Op::NotIn => "NOT IN",
            Op::IsNull => "IS NULL",
            Op::NotNull => "IS NOT NULL",
        }
    }

    /// `isnull` and `notnull` are the whole filter; everything else compares
    /// against something the caller wrote.
    pub const fn takes_value(self) -> bool {
        !matches!(self, Op::IsNull | Op::NotNull)
    }

    pub const fn takes_list(self) -> bool {
        matches!(self, Op::In | Op::NotIn)
    }
}

/// `city=eq.Oslo` — one column, one operator, and the values it compares to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filter {
    pub column: String,
    pub op: Op,
    /// Empty for `isnull`/`notnull`, one for a comparison, several for `in`.
    pub values: Vec<String>,
}

/// A unit of calendar time, for a window edge or a bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

impl Unit {
    pub const ALL: [Unit; 6] = [
        Unit::Minute,
        Unit::Hour,
        Unit::Day,
        Unit::Week,
        Unit::Month,
        Unit::Year,
    ];

    pub const fn keyword(self) -> &'static str {
        match self {
            Unit::Minute => "minute",
            Unit::Hour => "hour",
            Unit::Day => "day",
            Unit::Week => "week",
            Unit::Month => "month",
            Unit::Year => "year",
        }
    }

    pub fn from_keyword(word: &str) -> Option<Unit> {
        // Plurals accepted, because "last 7 days" is what anyone writes and
        // refusing it would be pedantry with a 400 attached.
        let word = word.strip_suffix('s').unwrap_or(word);
        Unit::ALL.into_iter().find(|u| u.keyword() == word)
    }

    pub fn keywords() -> Vec<&'static str> {
        Unit::ALL.into_iter().map(Unit::keyword).collect()
    }

    /// The function that moves a timestamp back to the start of its unit.
    ///
    /// `toMonday` rather than `toStartOfWeek`, which takes a mode argument and
    /// therefore has an opinion about Sunday that would be Flint's rather than
    /// anybody's.
    const fn truncate(self) -> &'static str {
        match self {
            Unit::Minute => "toStartOfMinute",
            Unit::Hour => "toStartOfHour",
            Unit::Day => "toStartOfDay",
            Unit::Week => "toMonday",
            Unit::Month => "toStartOfMonth",
            Unit::Year => "toStartOfYear",
        }
    }

    const fn interval(self) -> &'static str {
        match self {
            Unit::Minute => "MINUTE",
            Unit::Hour => "HOUR",
            Unit::Day => "DAY",
            Unit::Week => "WEEK",
            Unit::Month => "MONTH",
            Unit::Year => "YEAR",
        }
    }
}

/// One edge of a time window, as something Flint knows how to write.
///
/// Every variant but `Given` renders to a ClickHouse expression rather than to
/// a timestamp Flint computed. That is the whole decision, and it is the same
/// one `workspace.rs` already made when it asks the server for `now()`: **the
/// clock is ClickHouse's.** Resolving "the last seven days" here would put
/// Flint's clock in the answer, and a sidecar whose clock has drifted would
/// return a window nobody can reconcile with `query_log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edge {
    /// The server's clock, now.
    Now,
    /// The start of the calendar unit containing now, shifted by whole units.
    /// Truncated first and then shifted, so the shift always lands exactly on a
    /// boundary — which is what makes `previous_month` a month rather than
    /// thirty days.
    StartOf { unit: Unit, shift: i64 },
    /// Now, less a count of units. A rolling edge, not a calendar one.
    Ago { unit: Unit, count: u32 },
    /// A value the caller wrote. Bound and parsed by ClickHouse, like every
    /// other value a caller sends.
    Given(String),
    /// Another edge, moved back by whole units. Only a comparison needs this,
    /// and only its `previous_year` form: shifting a window back by its own
    /// span is expressible in the edges themselves, and shifting it back by a
    /// year is not.
    Less {
        base: Box<Edge>,
        unit: Unit,
        count: u32,
    },
}

impl Edge {
    /// The same edge, a year earlier.
    pub fn a_year_before(self) -> Edge {
        Edge::Less {
            base: Box::new(self),
            unit: Unit::Year,
            count: 1,
        }
    }
}

/// A half-open window on one column: `column >= from AND column < to`.
///
/// Half-open on purpose, and it is the detail that stops a caller
/// double-counting. Walk a month at a time over a closed interval and every
/// boundary row is in two answers; the row exactly at midnight belongs to the
/// day that is starting, once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub column: String,
    pub from: Option<Edge>,
    pub to: Option<Edge>,
}

/// The same question, asked of a second window, in one pass.
///
/// Not a `UNION` of two statements: the rows of both windows are read once and
/// told apart by a computed column, so the order, the page and the total are one
/// answer rather than two stitched together. The predicate becomes
/// `(this window) OR (that one)`, which ClickHouse resolves against the primary
/// index the same way it resolves either alone — so comparing a month with the
/// same month last year does not read the eleven months in between.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comparison {
    /// The window being compared — the one the caller put `compare` on, and
    /// **not** whichever window happens to be first.
    ///
    /// It lives here rather than in `Shape::windows` because the pair has to
    /// stay together. When it did not, a `compare` on the second of two time
    /// entries produced an `OR` between the *first* window and the second's
    /// previous — two unrelated columns and two unrelated periods, with the
    /// second's own window `AND`ed on top so that the previous branch could
    /// never match. It returned only the current half, under a label testing
    /// the wrong column, and it looked like an answer.
    pub current: Window,
    pub previous: Window,
    /// The column the two windows arrive under, and its two values.
    pub label: String,
}

/// A time column, grouped by the unit it is bucketed into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bucket {
    pub column: String,
    pub unit: Unit,
    /// The name the bucket comes back under. Defaults to the column's own, so
    /// that `order` by `ts` means the obvious thing.
    pub alias: String,
}

/// What a metric may do to a column. A closed set, like [`Op`], and for the
/// same reason: there is no path from a body to an expression Flint did not
/// write.
///
/// Which of these a given column accepts is not decided here — that is the
/// dataset inventory's job, because it depends on what the column *is* rather
/// than on what the function can compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agg {
    Count,
    Sum,
    Avg,
    Min,
    Max,
    Median,
    P95,
    P99,
    DistinctCount,
    /// The cheap, approximate distinct count.
    ///
    /// Its own name rather than a flag on `distinct_count`, because the two
    /// answer differently and the difference has to be unmissable at the call
    /// site. A caller who wants the estimate — and on a large table they
    /// usually should — asks for it by a name that says so.
    DistinctApprox,
    Any,
}

impl Agg {
    pub const ALL: [Agg; 11] = [
        Agg::Count,
        Agg::Sum,
        Agg::Avg,
        Agg::Min,
        Agg::Max,
        Agg::Median,
        Agg::P95,
        Agg::P99,
        Agg::DistinctCount,
        Agg::DistinctApprox,
        Agg::Any,
    ];

    pub const fn keyword(self) -> &'static str {
        match self {
            Agg::Count => "count",
            Agg::Sum => "sum",
            Agg::Avg => "avg",
            Agg::Min => "min",
            Agg::Max => "max",
            Agg::Median => "median",
            Agg::P95 => "p95",
            Agg::P99 => "p99",
            Agg::DistinctCount => "distinct_count",
            Agg::DistinctApprox => "distinct_count_approx",
            Agg::Any => "any",
        }
    }

    pub fn from_keyword(word: &str) -> Option<Agg> {
        Agg::ALL.into_iter().find(|a| a.keyword() == word)
    }

    pub fn keywords() -> Vec<&'static str> {
        Agg::ALL.into_iter().map(Agg::keyword).collect()
    }

    /// `count` is the only one that means something with no column: it counts
    /// rows. Every other one is a question about values.
    pub const fn column_optional(self) -> bool {
        matches!(self, Agg::Count)
    }

    /// The type this aggregation produces, given the type it was applied to.
    ///
    /// Needed because a `HAVING` compares against a *computed* value, and a
    /// value has to be bound with a type. Counts are integers whatever they
    /// counted; arithmetic comes back as a float, which is the safe superset
    /// for a comparison; and the three that pick an existing value out of the
    /// group keep that value's own type.
    fn result_type(self, source: &str) -> String {
        match self {
            Agg::Count | Agg::DistinctCount | Agg::DistinctApprox => "UInt64".to_string(),
            Agg::Sum | Agg::Avg | Agg::Median | Agg::P95 | Agg::P99 => "Float64".to_string(),
            Agg::Min | Agg::Max | Agg::Any => one_line(source),
        }
    }

    /// The ClickHouse function, given an already-quoted column.
    ///
    /// `distinct_count` is `uniqExact` rather than `uniq`. `uniq` is cheaper and
    /// approximate, and a field a caller reads as "how many distinct customers"
    /// must not be an estimate it was never told about. Somebody who wants the
    /// estimate can afford to ask for it by another name later; nobody can
    /// recover from a number they trusted.
    fn call(self, ident: &str) -> String {
        match self {
            Agg::Count => format!("count({ident})"),
            Agg::Sum => format!("sum({ident})"),
            Agg::Avg => format!("avg({ident})"),
            Agg::Min => format!("min({ident})"),
            Agg::Max => format!("max({ident})"),
            Agg::Median => format!("median({ident})"),
            Agg::P95 => format!("quantile(0.95)({ident})"),
            Agg::P99 => format!("quantile(0.99)({ident})"),
            Agg::DistinctCount => format!("uniqExact({ident})"),
            Agg::DistinctApprox => format!("uniq({ident})"),
            Agg::Any => format!("any({ident})"),
        }
    }
}

/// One computed column of an aggregated answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metric {
    pub aggregation: Agg,
    /// `None` only for `count`, which counts rows rather than values.
    pub column: Option<String>,
    /// The name this arrives under. Resolved before it gets here, so the
    /// renderer never has to invent one.
    pub alias: String,
}

/// A `GROUP BY`, and what is computed over it.
///
/// Both halves may be empty, but not both at once — that is checked where the
/// body is read, because it is a question about the request rather than about
/// the SQL. Dimensions with no metrics is a legitimate question ("which cities
/// are there"), and metrics with no dimensions is the other one ("how many
/// altogether").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aggregate {
    /// Rendered before the dimensions, because a time series reads left to
    /// right and the buckets are what it is a series over.
    ///
    /// A list, and it took a regression to learn why. One bucket reads like the
    /// obvious model — an answer is a series over *one* time — right up until
    /// somebody wants a day column beside an hour column, which is two grouping
    /// expressions and nothing exotic. Refusing it made Flint's own builder
    /// unable to ask a question it had always been able to ask.
    pub buckets: Vec<Bucket>,
    pub dimensions: Vec<String>,
    pub metrics: Vec<Metric>,
    /// A filter on what was computed — SQL spells it `HAVING`, because it is
    /// applied after the grouping rather than before it.
    ///
    /// The same tree a `filter` is, and it has to be: "cities with more than a
    /// thousand events, or fewer than ten" is one question, and splitting the
    /// grammar in two would make it two.
    pub having: Option<Predicate>,
}

impl Aggregate {
    /// The names an aggregated answer comes back under — which are the only
    /// names an `order` may then refer to, since the dataset's own columns are
    /// no longer what is being returned.
    pub fn output_names(&self) -> Vec<&str> {
        self.buckets
            .iter()
            .map(|b| b.alias.as_str())
            .chain(self.dimensions.iter().map(String::as_str))
            .chain(self.metrics.iter().map(|m| m.alias.as_str()))
            .collect()
    }
}

/// A filter that may be a group rather than a single comparison.
///
/// A query string can only ever express a conjunction: `city=eq.Oslo&n=gt.5` is
/// an `AND` and there is nowhere in the syntax to put anything else. A body can
/// hold a tree, and this is it — which is the whole reason the body exists, and
/// the only thing it may express that the query string cannot.
///
/// Both paths render through [`predicate`], deliberately. The guard that makes
/// any of this safe — a column matched against what the statement really
/// returns, a value bound rather than concatenated — is therefore the same
/// guard in both, and a change to it cannot fix one path and miss the other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Predicate {
    All(Vec<Predicate>),
    Any(Vec<Predicate>),
    Not(Box<Predicate>),
    Cmp(Filter),
}

/// How deep a caller's filter tree may go.
///
/// A body is written by whoever is calling, and nesting costs them nothing to
/// type — so the recursion below needs a floor that is not the stack's. Eight is
/// far past any tree a person writes and far short of anything that hurts.
const MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sort {
    pub column: String,
    pub desc: bool,
}

/// Everything the caller asked for that is not a parameter of the statement.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Shape {
    /// Empty means every column the statement returns.
    pub select: Vec<String>,
    pub filters: Vec<Filter>,
    pub order: Vec<Sort>,
    /// Already clamped to the endpoint's cap. `None` means "the cap".
    pub limit: Option<u64>,
    /// What the caller asked for before the clamp, when the two differ. Kept so
    /// the answer can say it served a smaller page than the one requested.
    pub limit_asked: Option<u64>,
    pub offset: u64,
    /// Where the last page stopped, when the caller sent one back.
    pub cursor: Option<Cursor>,
    /// A real `count()` over the same rows. Off unless asked for: it is a
    /// second pass over the data, and most callers paging a list do not want
    /// to pay for a total on every page.
    pub count: bool,
    /// The filter tree, which only a body can carry. `AND`ed with `filters`
    /// rather than replacing them, so a call that uses both means both — there
    /// is no precedence to learn and nothing is silently dropped.
    pub tree: Option<Predicate>,
    /// Group and measure. Also body-only: a query string has nowhere to say
    /// which of two columns is the dimension and which is the metric.
    pub aggregate: Option<Aggregate>,
    /// The windows in time this answer is about, `AND`ed together and with
    /// everything else — so "created in the last week and updated today" is two
    /// of these rather than a question Flint cannot hold.
    pub windows: Vec<Window>,
    /// A second window, beside the first. Requires `window`, because there is
    /// nothing to compare against otherwise.
    pub compare: Option<Comparison>,
}

impl Shape {
    /// Whether the statement has to be wrapped at all.
    ///
    /// An unshaped call runs exactly the statement that was published, with no
    /// subquery around it and no `DESCRIBE` in front of it — the endpoints that
    /// existed before any of this cost precisely what they used to.
    pub fn wraps(&self) -> bool {
        !self.select.is_empty()
            || !self.filters.is_empty()
            || self.tree.is_some()
            || self.aggregate.is_some()
            || !self.windows.is_empty()
            || self.compare.is_some()
            || !self.order.is_empty()
            || self.limit.is_some()
            || self.offset > 0
            || self.cursor.is_some()
    }

    /// Whether the call names columns, and so needs the statement described
    /// before it can run.
    pub fn names_columns(&self) -> bool {
        !self.select.is_empty()
            || !self.filters.is_empty()
            || self.tree.is_some()
            || self.aggregate.is_some()
            || !self.windows.is_empty()
            || self.compare.is_some()
            || !self.order.is_empty()
            || self.cursor.is_some()
    }
}

/// Read the query string as a shape.
///
/// Precedence, in order: a name the statement declares is that statement's
/// parameter; then a reserved name is Flint's; anything left is a filter on a
/// column. Which is why an unrecognised key is an *error* here rather than the
/// silence it used to be — under the old rules a misspelt `citty=Oslo` returned
/// the unfiltered table and looked like an answer.
pub fn parse(
    query: &[(String, String)],
    declared: &[String],
    max_rows: u64,
) -> Result<Shape, String> {
    let mut shape = Shape::default();

    for (key, value) in query {
        if declared.iter().any(|d| d == key) {
            continue;
        }
        match key.as_str() {
            // Read by the handler before a shape exists at all: the
            // credential it authenticates with, the content type it renders,
            // and the revision it resolves. None of them is a column, and
            // falling through to the filter parser made `?v=4` answer 400 with
            // a sentence about operators to a caller who had done nothing
            // wrong. Every name here is also in `RESERVED`, which is what the
            // document promises — the test below holds the two together.
            "token" | "key" | "format" | "v" => continue,
            "limit" => {
                let asked: u64 = value
                    .trim()
                    .parse()
                    .map_err(|_| format!("`limit={value}` is not a whole number of rows"))?;
                if asked == 0 {
                    return Err("`limit=0` asks for nothing; leave it out instead".into());
                }
                shape.limit = Some(asked.min(max_rows));
                if asked > max_rows {
                    shape.limit_asked = Some(asked);
                }
            }
            "offset" => {
                shape.offset = value
                    .trim()
                    .parse()
                    .map_err(|_| format!("`offset={value}` is not a whole number of rows"))?;
            }
            "cursor" => shape.cursor = Some(cursor::decode(value)?),
            "order" => shape.order = parse_order(value)?,
            "select" => shape.select = parse_select(value)?,
            "count" => shape.count = parse_count(value)?,
            _ => shape.filters.push(parse_filter(key, value)?),
        }
    }

    // Checked here rather than at render time, because both halves of the
    // objection are in the query string and neither is about the data.
    if let Some(cursor) = &shape.cursor {
        if shape.order.is_empty() {
            return Err(
                "a cursor says where the last page stopped in a particular order, so the \
                 order has to come with it: add the same `order` you paged with"
                    .into(),
            );
        }
        let asked = order_signature(&shape.order);
        if cursor.order != asked {
            return Err(format!(
                "this cursor was made for `order={}` and is being used with `order={asked}`; \
                 it points at a row that order has never reached",
                cursor.order
            ));
        }
        if cursor.values.len() != shape.order.len() {
            return Err("this cursor does not carry a value for every ordering column".into());
        }
        if shape.offset > 0 {
            // Both mean "where to start", and honouring both would skip a page
            // the caller never asked to skip.
            return Err("a cursor already says where you are; leave `offset` out".into());
        }
    }

    Ok(shape)
}

/// The order, written the way the query string writes it. One rendering, used
/// to stamp a cursor and to check one — two would eventually disagree.
pub fn order_signature(order: &[Sort]) -> String {
    order
        .iter()
        .map(|s| {
            if s.desc {
                format!("{}.desc", s.column)
            } else {
                s.column.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn parse_order(raw: &str) -> Result<Vec<Sort>, String> {
    let mut out = Vec::new();
    for term in raw.split(',') {
        let term = term.trim();
        if term.is_empty() {
            continue;
        }
        // Split from the right, and only when the tail is a direction: a column
        // may legitimately be called `a.b`, and guessing wrong about which half
        // is the name would order by a column nobody asked for.
        let (column, desc) = match term.rsplit_once('.') {
            Some((head, "desc")) if !head.is_empty() => (head, true),
            Some((head, "asc")) if !head.is_empty() => (head, false),
            _ => (term, false),
        };
        out.push(Sort {
            column: column.to_string(),
            desc,
        });
    }
    if out.is_empty() {
        return Err("`order=` names no column".into());
    }
    Ok(out)
}

fn parse_select(raw: &str) -> Result<Vec<String>, String> {
    let out: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if out.is_empty() {
        return Err("`select=` names no column".into());
    }
    Ok(out)
}

fn parse_count(raw: &str) -> Result<bool, String> {
    match raw.trim() {
        "exact" | "true" | "1" | "yes" => Ok(true),
        "none" | "false" | "0" | "no" | "" => Ok(false),
        other => Err(format!(
            "`count={other}` is not something this endpoint counts; use count=exact"
        )),
    }
}

/// `gte.10`, `in.a,b,c`, `isnull`.
///
/// The operator is never optional. `?state=in.progress` is otherwise two
/// readings of the same text — an `in` list of one value, or an equality test
/// against "in.progress" — and a filter that silently picks the wrong one
/// returns a plausible answer to a question the caller did not ask.
fn parse_filter(column: &str, raw: &str) -> Result<Filter, String> {
    if column.len() > 128 {
        return Err(format!("`{column}` is too long to be a column name"));
    }
    let (word, rest) = match raw.split_once('.') {
        Some((word, rest)) => (word, Some(rest)),
        None => (raw, None),
    };
    let Some(op) = Op::from_keyword(word) else {
        return Err(format!(
            "`{column}={raw}` needs an operator: {}. `{column}=eq.{raw}` is probably what you meant",
            Op::ALL
                .iter()
                .map(|o| o.keyword())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    };
    let values = match rest {
        None if op.takes_value() => {
            return Err(format!(
                "`{column}={raw}` compares against nothing — write `{column}={}.something`",
                op.keyword()
            ))
        }
        None => Vec::new(),
        Some(_) if !op.takes_value() => {
            return Err(format!(
                "`{}` takes no value — write `{column}={}`",
                op.keyword(),
                op.keyword()
            ))
        }
        Some(list) if op.takes_list() => {
            let values: Vec<String> = list
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect();
            if values.is_empty() {
                return Err(format!("`{column}={raw}` lists nothing to match"));
            }
            values
        }
        // An empty value is a value: `city=eq.` asks for the rows whose city
        // is the empty string, which is a question with an answer.
        Some(one) => vec![one.to_string()],
    };
    Ok(Filter {
        column: column.to_string(),
        op,
        values,
    })
}

// ── Types, as far as a filter needs to care ─────────────────────────────

/// A type as ClickHouse wrote it, on one line.
///
/// `DESCRIBE` pretty-prints a deeply nested type across several lines, so a
/// named tuple comes back as "Tuple(\n    x UInt8,\n    y String)". That is the
/// same type, and it reads as a rendering fault everywhere it is shown — in the
/// schema, in the OpenAPI document, in the panel on the APIs page.
pub fn one_line(ty: &str) -> String {
    let mut out = String::with_capacity(ty.len());
    let mut spaced = false;
    for ch in ty.trim().chars() {
        if ch.is_whitespace() {
            spaced = true;
            continue;
        }
        // A comma supplies its own separation; anything else that followed
        // whitespace keeps one space.
        if spaced && !out.is_empty() && ch != ',' && !out.ends_with('(') {
            out.push(' ');
        }
        spaced = false;
        out.push(ch);
    }
    out
}

/// The type inside `Nullable(...)` and `LowCardinality(...)`, which are about
/// storage rather than about what a value means.
pub fn base_type(ty: &str) -> &str {
    let ty = ty.trim();
    for wrapper in ["Nullable(", "LowCardinality("] {
        if let Some(rest) = ty.strip_prefix(wrapper) {
            if let Some(inner) = rest.strip_suffix(')') {
                return base_type(inner);
            }
        }
    }
    ty
}

pub fn is_nullable(ty: &str) -> bool {
    let ty = ty.trim();
    if let Some(rest) = ty.strip_prefix("LowCardinality(") {
        if let Some(inner) = rest.strip_suffix(')') {
            return is_nullable(inner);
        }
    }
    ty.starts_with("Nullable(")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// Compared as a string, whatever it is stored as. Enums included: a caller
    /// who knows the enum knows its labels, not its numbers.
    Text,
    Number,
    /// Bound as a string and parsed by ClickHouse, so `2024-01-01`,
    /// `2024-01-01 12:00:00` and an epoch all reach the same column.
    Temporal,
    /// Its own type is the right one to bind — UUID, IPv4, IPv6, Bool.
    Native,
    /// Arrays, maps, tuples, nested and everything else that is not one value.
    Other,
}

pub fn family(ty: &str) -> Family {
    let base = base_type(ty);
    let head = base.split('(').next().unwrap_or(base).trim();
    match head {
        "String" | "FixedString" => Family::Text,
        "Bool" | "Boolean" | "UUID" | "IPv4" | "IPv6" => Family::Native,
        "Date" | "Date32" | "DateTime" | "DateTime64" => Family::Temporal,
        // `Interval*` reads as a number and is not one; check it before the
        // `Int` prefix swallows it.
        h if h.starts_with("Interval") => Family::Other,
        h if h.starts_with("Enum") => Family::Text,
        h if h.starts_with("Int") || h.starts_with("UInt") || h.starts_with("Float") => {
            Family::Number
        }
        "Decimal" | "Decimal32" | "Decimal64" | "Decimal128" | "Decimal256" => Family::Number,
        _ => Family::Other,
    }
}

/// A type is only ever embedded in SQL as a `{name:Type}` binding, and it comes
/// from ClickHouse's own `DESCRIBE` — but it is still the one string here that
/// did not start as a literal, so it is checked before it goes anywhere.
fn safe_type(ty: &str) -> bool {
    !ty.is_empty()
        && ty.len() <= 128
        && ty
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'(' | b')' | b',' | b'_' | b' '))
}

/// Which operators this column can be filtered with, for the endpoint's own
/// documentation. Empty means the column is returned but cannot be filtered —
/// said plainly in the docs rather than discovered by a caller's 400.
pub fn ops_for(ty: &str) -> Vec<&'static str> {
    let mut ops: Vec<&'static str> = match family(ty) {
        Family::Other => return Vec::new(),
        Family::Text => vec![
            "eq", "ne", "gt", "gte", "lt", "lte", "like", "ilike", "in", "nin",
        ],
        Family::Number | Family::Temporal => {
            vec!["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"]
        }
        Family::Native => vec!["eq", "ne", "in", "nin"],
    };
    // `IS NULL` on a column that cannot hold one is a filter that always
    // matches nothing. Offering it would be offering a wrong answer.
    if is_nullable(ty) {
        ops.push("isnull");
        ops.push("notnull");
    }
    ops
}

// ── Rendering ───────────────────────────────────────────────────────────

/// Backticks, and the two characters ClickHouse escapes inside them. Every
/// identifier that reaches here has already been matched against a column the
/// statement returns; this is the second lock on the same door.
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
}

/// A parameter prefix no declared parameter is using.
///
/// `{flint_0:String}` would collide with a statement that happens to declare
/// `flint_0`, and the collision would be a caller's filter silently answering
/// the statement's own parameter. Cheaper to find a prefix that is free.
pub fn free_prefix(declared: &[String]) -> String {
    let mut prefix = String::from("flint_f");
    while declared.iter().any(|d| d.starts_with(prefix.as_str())) {
        prefix.push('_');
    }
    prefix
}

struct Binder {
    prefix: String,
    params: Vec<(String, String)>,
}

impl Binder {
    fn bind(&mut self, value: &str, ty: &str) -> Result<String, String> {
        if !safe_type(ty) {
            return Err(format!("`{ty}` is not a type this endpoint can filter on"));
        }
        let name = format!("{}{}", self.prefix, self.params.len());
        self.params.push((name.clone(), value.to_string()));
        Ok(format!("{{{name}:{ty}}}"))
    }
}

fn column<'a>(columns: &'a [ColumnMeta], name: &str) -> Result<&'a ColumnMeta, String> {
    columns.iter().find(|c| c.name == name).ok_or_else(|| {
        // No noun for whatever holds these columns: this is reached from a
        // published statement and from a dataset alike, and "this endpoint"
        // was a lie on one of the two paths from the day the second arrived.
        //
        // Capped, and the cap counts itself. A wide table otherwise puts forty
        // names into an error nobody reads to the end — and a list that stops
        // without saying so reads as the whole set, which leaves somebody
        // hunting for a column that was there all along.
        const SHOWN: usize = 20;
        let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
        let known = names
            .iter()
            .take(SHOWN)
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        let rest = names.len().saturating_sub(SHOWN);
        if rest > 0 {
            format!(
                "`{name}` is not one of the {} columns here; they include {known}, \
                 and {rest} more",
                names.len()
            )
        } else {
            format!("`{name}` is not one of the columns here; they are {known}")
        }
    })
}

/// One value, bound in whatever type the column will actually compare against.
fn value_expr(binder: &mut Binder, col: &Named, value: &str) -> Result<String, String> {
    match family(&col.ty) {
        Family::Text => binder.bind(value, "String"),
        Family::Number | Family::Native => binder.bind(value, base_type(&col.ty)),
        // `parseDateTimeBestEffort`, not the `OrNull` form: an unparseable date
        // must fail loudly. The `OrNull` version turns `?ts=gte.yesterday` into
        // a NULL comparison, which matches no rows — an empty answer that looks
        // exactly like a true one.
        Family::Temporal => Ok(temporal_parse(&col.ty, &binder.bind(value, "String")?)),
        Family::Other => Err(format!(
            "`{}` is {} — a filter compares single values, not collections",
            col.said, col.ty
        )),
    }
}

/// A timestamp, parsed at the precision its column actually keeps.
///
/// The second-resolution parser on a `DateTime64(3)` silently drops the
/// milliseconds, and a cursor built on a truncated value points at the start of
/// a second rather than at the row it came from — every other row inside that
/// second is then skipped. Filters have the same problem in miniature.
fn temporal_parse(ty: &str, bound: &str) -> String {
    match datetime64_precision(ty) {
        Some(precision) => format!("parseDateTime64BestEffort({bound}, {precision})"),
        None => format!("parseDateTimeBestEffort({bound})"),
    }
}

/// `DateTime64(6, 'UTC')` → 6. `DateTime64` on its own is ClickHouse's default
/// of 3. Anything else is not a `DateTime64` at all.
fn datetime64_precision(ty: &str) -> Option<u8> {
    let base = base_type(ty);
    let rest = base.strip_prefix("DateTime64")?.trim();
    if rest.is_empty() {
        return Some(3);
    }
    let inner = rest.strip_prefix('(')?.strip_suffix(')')?;
    let first = inner.split(',').next()?.trim();
    Some(first.parse::<u8>().ok().filter(|p| *p <= 9).unwrap_or(3))
}

/// The rows strictly after the one a cursor points at.
///
/// Written out rather than as a tuple comparison, because `(a, b) > (x, y)`
/// only says the right thing when every column runs the same way, and an order
/// with a `.desc` in it does not. The expanded form is the same claim, one
/// column at a time: equal on everything before it, and past it on this one.
fn keyset(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    order: &[Sort],
    values: &[String],
) -> Result<String, String> {
    if let Some(nullable) = cursor_blocker(order, columns) {
        return Err(format!(
            "`{nullable}` can be null, and a comparison against null is neither true nor \
             false — a cursor over this order would skip rows. Page it with `offset`, or \
             order by something that cannot be null"
        ));
    }
    let mut clauses = Vec::with_capacity(order.len());
    for (i, sort) in order.iter().enumerate() {
        let mut conjunction = Vec::with_capacity(i + 1);
        for (earlier, value) in order.iter().zip(values).take(i) {
            let col = Named::column(column(columns, &earlier.column)?);
            conjunction.push(format!(
                "{} = {}",
                col.expr,
                value_expr(binder, &col, value)?
            ));
        }
        let col = Named::column(column(columns, &sort.column)?);
        conjunction.push(format!(
            "{} {} {}",
            col.expr,
            if sort.desc { "<" } else { ">" },
            value_expr(binder, &col, &values[i])?
        ));
        clauses.push(format!("({})", conjunction.join(" AND ")));
    }
    Ok(format!("({})", clauses.join(" OR ")))
}

/// Why this order cannot carry a cursor, named — or `None` when it can.
pub fn cursor_blocker(order: &[Sort], columns: &[ColumnMeta]) -> Option<String> {
    order.iter().find_map(|sort| {
        let col = columns.iter().find(|c| c.name == sort.column)?;
        is_nullable(&col.r#type).then(|| col.name.clone())
    })
}

/// The cursor for the last row of a page: the values it was ordered by.
///
/// `None` when a value is not something that can be sent back and compared — an
/// array, or a null that should not have been there. A page with no cursor
/// falls back to `offset`, which is worse but never wrong about what it is.
pub fn cursor_for(order: &[Sort], names: &[String], row: &[serde_json::Value]) -> Option<Cursor> {
    let mut values = Vec::with_capacity(order.len());
    for sort in order {
        let at = names.iter().position(|n| *n == sort.column)?;
        values.push(match row.get(at)? {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Bool(b) => b.to_string(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => return None,
        });
    }
    Some(Cursor {
        order: order_signature(order),
        values,
    })
}

/// What each name in an aggregated answer resolves to, for a `HAVING`.
///
/// A metric is not a column, so it has no declared type — but a value compared
/// against it still has to be bound as something. `Agg::result_type` supplies
/// it: a count is an integer whatever it counted, arithmetic comes back as a
/// float, and the three that pick an existing value out of the group keep that
/// value's own type.
fn named_output(
    columns: &[ColumnMeta],
    aggregate: &Aggregate,
    label: Option<&Labelled>,
    name: &str,
) -> Result<Named, String> {
    // The comparison's label is one of the answer's columns, so it can be
    // filtered like the rest. It was not, for a while, and the refusal listed
    // the other columns — telling a caller that an answer does not return a
    // column they could see in their own rows.
    if let Some(label) = label {
        if label.name == name {
            return Ok(Named {
                expr: label.expr.clone(),
                // `if(…, 'current', 'previous')` is text, whatever the column
                // it tests is.
                ty: "String".to_string(),
                said: name.to_string(),
            });
        }
    }

    let expr = output_expr(columns, aggregate, label, name)?.ok_or_else(|| {
        let mut names: Vec<&str> = label.iter().map(|l| l.name).collect();
        names.extend(aggregate.output_names());
        format!(
            "`{name}` is not something this answer returns, so it cannot be filtered after \
             the grouping; it returns {}",
            names.join(", ")
        )
    })?;

    if let Some(metric) = aggregate.metrics.iter().find(|m| m.alias == name) {
        let source = match &metric.column {
            Some(column_name) => column(columns, column_name)?.r#type.clone(),
            None => "UInt64".to_string(),
        };
        return Ok(Named {
            expr,
            ty: metric.aggregation.result_type(&source),
            said: name.to_string(),
        });
    }

    // A dimension or the bucket: grouped, not computed, so it keeps its own
    // type. Filtering one here rather than in `filter` is redundant but not
    // wrong, and refusing it would be a rule nobody could predict.
    let ty = match aggregate.buckets.iter().find(|b| b.alias == name) {
        Some(bucket) => column(columns, &bucket.column)?.r#type.clone(),
        None => column(columns, name)?.r#type.clone(),
    };
    Ok(Named {
        expr,
        ty,
        said: name.to_string(),
    })
}

/// The same tree as a `WHERE`, over what the answer computed.
fn render_having(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    aggregate: &Aggregate,
    label: Option<&Labelled>,
    node: &Predicate,
    depth: usize,
) -> Result<String, String> {
    if depth > MAX_DEPTH {
        return Err(format!(
            "this filter nests more than {MAX_DEPTH} groups deep — flatten it, \
             or ask for the rows in two calls"
        ));
    }
    match node {
        Predicate::Cmp(filter) => {
            let named = named_output(columns, aggregate, label, &filter.column)?;
            compare(binder, &named, filter)
        }
        Predicate::Not(inner) => Ok(format!(
            "NOT ({})",
            render_having(binder, columns, aggregate, label, inner, depth + 1)?
        )),
        Predicate::All(parts) | Predicate::Any(parts) => {
            let keyword = if matches!(node, Predicate::All(_)) {
                "all"
            } else {
                "any"
            };
            if parts.is_empty() {
                return Err(format!(
                    "an empty `{keyword}` says nothing about which rows you want"
                ));
            }
            let joiner = if matches!(node, Predicate::All(_)) {
                " AND "
            } else {
                " OR "
            };
            let rendered = parts
                .iter()
                .map(|part| render_having(binder, columns, aggregate, label, part, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("({})", rendered.join(joiner)))
        }
    }
}

/// A tree, rendered into one parenthesised expression.
///
/// Empty groups are refused rather than given a value. `All([])` is vacuously
/// true and `Any([])` vacuously false, so the same mistake — a group whose
/// contents were built by a loop that produced nothing — would silently return
/// every row in one case and none in the other. Neither is an answer to the
/// question that was asked, and both look like one.
fn render(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    node: &Predicate,
    depth: usize,
) -> Result<String, String> {
    if depth > MAX_DEPTH {
        return Err(format!(
            "this filter nests more than {MAX_DEPTH} groups deep — flatten it, \
             or ask for the rows in two calls"
        ));
    }
    match node {
        Predicate::Cmp(filter) => predicate(binder, columns, filter),
        Predicate::Not(inner) => Ok(format!(
            "NOT ({})",
            render(binder, columns, inner, depth + 1)?
        )),
        Predicate::All(parts) | Predicate::Any(parts) => {
            let keyword = if matches!(node, Predicate::All(_)) {
                "all"
            } else {
                "any"
            };
            if parts.is_empty() {
                return Err(format!(
                    "an empty `{keyword}` says nothing about which rows you want"
                ));
            }
            let joiner = if matches!(node, Predicate::All(_)) {
                " AND "
            } else {
                " OR "
            };
            let rendered = parts
                .iter()
                .map(|part| render(binder, columns, part, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("({})", rendered.join(joiner)))
        }
    }
}

/// What a filter's column name means, for whoever is asking.
///
/// Two callers and two meanings. A `WHERE` names the dataset's own columns, so
/// a name resolves to a quoted identifier and that column's declared type. A
/// `HAVING` names what the answer *computed*, so the same syntax resolves to an
/// aggregate expression and the type that aggregate produces.
///
/// One renderer for both, deliberately: the operators, the arity rules, the
/// null handling and the binding are the parts that must not drift, and the
/// only thing that differs between the two is what a name points at.
impl Named {
    /// A dataset's own column, named as itself.
    fn column(col: &ColumnMeta) -> Named {
        Named {
            expr: quote_ident(&col.name),
            ty: col.r#type.clone(),
            said: col.name.clone(),
        }
    }
}

struct Named {
    /// What to write on the left of the operator.
    expr: String,
    /// The type its values are bound as.
    ty: String,
    /// What to call it in a complaint — the caller's own word, not the
    /// expression, which they never wrote.
    said: String,
}

fn predicate(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    filter: &Filter,
) -> Result<String, String> {
    compare(
        binder,
        &Named::column(column(columns, &filter.column)?),
        filter,
    )
}

fn compare(binder: &mut Binder, col: &Named, filter: &Filter) -> Result<String, String> {
    let ident = &col.expr;

    if !filter.op.takes_value() {
        if !is_nullable(&col.ty) {
            return Err(format!(
                "`{}` is {} and can never be null, so `{}` would match nothing",
                col.said,
                col.ty,
                filter.op.keyword()
            ));
        }
        return Ok(format!("{ident} {}", filter.op.infix()));
    }

    if matches!(filter.op, Op::Like | Op::ILike) && family(&col.ty) != Family::Text {
        return Err(format!(
            "`{}` is {} — `{}` compares text",
            col.said,
            col.ty,
            filter.op.keyword()
        ));
    }

    if filter.op.takes_list() {
        let values = filter
            .values
            .iter()
            .map(|v| value_expr(binder, col, v))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(format!(
            "{ident} {} ({})",
            filter.op.infix(),
            values.join(", ")
        ));
    }

    let value = value_expr(binder, col, &filter.values[0])?;
    Ok(format!("{ident} {} {value}", filter.op.infix()))
}

/// A trailing semicolon, or a trailing line comment, would end the statement
/// before the parenthesis that wraps it. The comment is handled by putting the
/// closing paren on its own line; the semicolon has to go.
fn inner_statement(sql: &str) -> &str {
    sql.trim_end().trim_end_matches(';').trim_end()
}

/// The `FROM` a wrapper needs for the statement it is wrapping.
///
/// A dataset that is a plain table arrives here as `SELECT * FROM db.tbl`, and
/// wrapping that in parentheses produced
///
/// ```text
/// SELECT `login`, count() AS `rows`
/// FROM (
/// SELECT * FROM `default`.`actors`
/// )
/// GROUP BY `login`
/// ```
///
/// which is what the query page's form showed as the statement it was about to
/// send. It is correct and it costs nothing to run — ClickHouse flattens it —
/// and it is three lines of noise in the one place the product asks somebody to
/// read generated SQL and decide whether to trust it. A form that cannot write
/// `FROM actors` does not read like a form that knows SQL, and the whole
/// argument for showing the statement is that reading it should be reassuring.
///
/// So a wrapper over nothing but a table reference reads `FROM db.tbl`.
/// Everything else keeps the subquery — a view's body, a published dataset's own
/// SELECT, a statement with a comment or a WHERE in it — because for those the
/// parentheses are load-bearing.
fn from_clause(inner: &str) -> String {
    match table_reference(inner) {
        Some(reference) => format!("\nFROM {reference}"),
        None => format!("\nFROM (\n{}\n)", inner_statement(inner)),
    }
}

/// The table, when the statement is exactly a whole read of one and nothing
/// else.
fn table_reference(sql: &str) -> Option<&str> {
    let rest = inner_statement(sql).strip_prefix("SELECT * FROM ")?;
    is_reference(rest).then_some(rest)
}

/// Whether the text is one identifier, or two joined by a dot, and nothing more.
///
/// Scanned rather than pattern-matched on whitespace, because `quote_ident` will
/// happily emit `` `my db`.`t` `` and a name with a space in it is still just a
/// name. Anything this cannot account for — a function call, an alias, a second
/// clause, a `FINAL`, a comment — falls through to `false`, which keeps the
/// subquery. Being wrong in that direction costs a pair of parentheses; being
/// wrong the other way would splice something unparsed into a FROM.
fn is_reference(rest: &str) -> bool {
    let mut chars = rest.chars().peekable();
    for part in 0..2 {
        match chars.peek() {
            // A quoted name runs to its closing backquote, and `quote_ident`
            // escapes both the backquote and the backslash it escapes with.
            Some('`') => {
                chars.next();
                loop {
                    match chars.next() {
                        None => return false,
                        Some('\\') => {
                            if chars.next().is_none() {
                                return false;
                            }
                        }
                        Some('`') => break,
                        Some(_) => {}
                    }
                }
            }
            Some(c) if c.is_ascii_alphabetic() || *c == '_' => {
                while chars
                    .peek()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
                {
                    chars.next();
                }
            }
            _ => return false,
        }
        match chars.next() {
            None => return true,
            Some('.') if part == 0 => {}
            Some(_) => return false,
        }
    }
    false
}

#[derive(Debug, Clone)]
pub struct Wrapped {
    pub sql: String,
    pub params: Vec<(String, String)>,
    /// Columns the wrapper asked for that the caller did not. Dropped from the
    /// answer before it is written — see `wrap`.
    pub extra_columns: Vec<String>,
}

/// The statement, wrapped in exactly what the caller asked for.
///
/// `fetch` is a row count Flint chose, not one a caller typed — the handler
/// asks for one row more than the page it will serve, which is what makes
/// "there is more behind this" a fact rather than a guess.
///
/// `None` asks for no `LIMIT` at all, and there is exactly one caller for it:
/// a published *document*, which is wrapped once to become a statement and
/// then wrapped again by the endpoint's own shape layer. A page belongs to the
/// outer wrap. An inner `LIMIT` there would not be a page size, it would be a
/// ceiling on the whole answer — and a caller paging past it would be handed
/// nothing with nothing to say why.
pub fn wrap(
    inner: &str,
    shape: &Shape,
    columns: &[ColumnMeta],
    fetch: Option<u64>,
    prefix: &str,
) -> Result<Wrapped, String> {
    let mut binder = Binder {
        prefix: prefix.to_string(),
        params: Vec::new(),
    };

    // A cursor is made of the ordering values of the last row, so those columns
    // have to come back even when the caller asked for a narrower set. They are
    // dropped again before the answer is written: `?select=city` that quietly
    // returned `n` as well would be answering a question nobody asked.
    // Before the projection, because the projection is the first thing to name
    // it — and its values have to be bound in the order they are used.
    let labelled = match &shape.compare {
        Some(comparison) => Some(Labelled {
            name: comparison.label.as_str(),
            expr: label_expr(&mut binder, columns, &comparison.current)?,
        }),
        None => None,
    };

    let mut extra_columns = Vec::new();
    let projection = if let Some(aggregate) = &shape.aggregate {
        // An aggregated answer is not the dataset's columns any more, so a
        // cursor cannot be taken off it and nothing is added to the projection
        // on the wrapper's own account.
        group_projection(columns, aggregate, labelled.as_ref())?
    } else if shape.select.is_empty() {
        "*".to_string()
    } else {
        let mut wanted = shape.select.clone();
        for sort in &shape.order {
            if !wanted.contains(&sort.column) {
                wanted.push(sort.column.clone());
                extra_columns.push(sort.column.clone());
            }
        }
        wanted
            .iter()
            .map(|name| column(columns, name).map(|c| quote_ident(&c.name)))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ")
    };

    let mut sql = format!("SELECT {projection}{}", from_clause(inner));

    let mut predicates = shape
        .filters
        .iter()
        .map(|f| predicate(&mut binder, columns, f))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(tree) = &shape.tree {
        predicates.push(render(&mut binder, columns, tree, 0)?);
    }
    if let Some(windows) = windows_predicate(&mut binder, columns, shape)? {
        predicates.push(windows);
    }
    if let Some(cursor) = &shape.cursor {
        predicates.push(keyset(&mut binder, columns, &shape.order, &cursor.values)?);
    }
    if !predicates.is_empty() {
        sql.push_str(&format!("\nWHERE {}", predicates.join(" AND ")));
    }

    if let Some(aggregate) = &shape.aggregate {
        let terms = group_terms(columns, aggregate, labelled.as_ref())?;
        if !terms.is_empty() {
            sql.push_str(&format!("\nGROUP BY {}", terms.join(", ")));
        }
    }

    // After the grouping and before the order: what was computed can be
    // filtered, and only here — a `WHERE` runs before there is anything to
    // filter.
    if let Some(aggregate) = &shape.aggregate {
        if let Some(having) = &aggregate.having {
            let rendered = render_having(
                &mut binder,
                columns,
                aggregate,
                labelled.as_ref(),
                having,
                0,
            )?;
            sql.push_str(&format!("\nHAVING {rendered}"));
        }
    }

    if !shape.order.is_empty() {
        // What an order may name changes with the answer. Unaggregated, it is
        // the dataset's own columns; aggregated, it is what came *out* — the
        // dimensions and the metric names — because `avg_temperature` is not a
        // column of anything and `temperature` is no longer being returned.
        let terms = match &shape.aggregate {
            Some(aggregate) => shape
                .order
                .iter()
                .map(
                    |s| match output_expr(columns, aggregate, labelled.as_ref(), &s.column)? {
                        Some(expr) => Ok(format!("{expr}{}", if s.desc { " DESC" } else { "" })),
                        None => {
                            let mut names: Vec<&str> = labelled.iter().map(|l| l.name).collect();
                            names.extend(aggregate.output_names());
                            Err(format!(
                                "`{}` is not something this answer returns; order by one of {}",
                                s.column,
                                names.join(", ")
                            ))
                        }
                    },
                )
                .collect::<Result<Vec<_>, _>>()?,
            None => shape
                .order
                .iter()
                .map(|s| {
                    column(columns, &s.column).map(|c| {
                        format!(
                            "{}{}",
                            quote_ident(&c.name),
                            if s.desc { " DESC" } else { "" }
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
        };
        sql.push_str(&format!("\nORDER BY {}", terms.join(", ")));
    }

    if let Some(fetch) = fetch {
        sql.push_str(&format!("\nLIMIT {fetch}"));
    }
    if shape.offset > 0 {
        // `OFFSET` with no `LIMIT` is not ClickHouse syntax, so an unpaged wrap
        // that had been given an offset would render a statement the server
        // refuses. Nothing sends one today — a document's offset is the
        // caller's and lands on the outer wrap — and this says so rather than
        // waiting to be discovered as a parse error.
        if fetch.is_none() {
            return Err("a wrap with no page cannot carry an offset".into());
        }
        sql.push_str(&format!(" OFFSET {}", shape.offset));
    }

    Ok(Wrapped {
        sql,
        params: binder.params,
        extra_columns,
    })
}

/// What a `GROUP BY` names: the bucket expression, then the dimensions.
///
/// The expression rather than the alias, deliberately. ClickHouse accepts
/// either, but grouping by an alias that shadows a real column of the same name
/// — which is exactly what a bucket called `ts` over a column called `ts` does —
/// is a question about resolution order that nobody should have to answer.
fn group_terms(
    columns: &[ColumnMeta],
    aggregate: &Aggregate,
    label: Option<&Labelled>,
) -> Result<Vec<String>, String> {
    let mut terms = Vec::new();
    if let Some(label) = label {
        terms.push(label.expr.clone());
    }
    for bucket in &aggregate.buckets {
        terms.push(bucket_expr(columns, bucket)?);
    }
    for dimension in &aggregate.dimensions {
        terms.push(quote_ident(&column(columns, dimension)?.name));
    }
    Ok(terms)
}

/// `toStartOfDay(`ts`)` — the expression a bucket groups by.
fn bucket_expr(columns: &[ColumnMeta], bucket: &Bucket) -> Result<String, String> {
    let column = column(columns, &bucket.column)?;
    // Checked here rather than left to `toStartOfDay('Oslo')`, whose complaint
    // is ClickHouse's and names a function the caller never wrote.
    if family(&column.r#type) != Family::Temporal {
        return Err(format!(
            "`{}` is {} — a granularity buckets a date or a timestamp",
            column.name, column.r#type
        ));
    }
    Ok(format!(
        "{}({})",
        bucket.unit.truncate(),
        quote_ident(&column.name)
    ))
}

/// One edge of a window, as SQL.
fn edge_expr(binder: &mut Binder, ty: &str, edge: &Edge) -> Result<String, String> {
    Ok(match edge {
        Edge::Now => "now()".to_string(),
        Edge::StartOf { unit, shift } => {
            let truncated = format!("{}(now())", unit.truncate());
            match shift {
                0 => truncated,
                // `INTERVAL -1 MONTH` is legal, but writing the sign into the
                // operator reads the way the question was asked.
                n if *n < 0 => format!("{truncated} - INTERVAL {} {}", -n, unit.interval()),
                n => format!("{truncated} + INTERVAL {n} {}", unit.interval()),
            }
        }
        Edge::Ago { unit, count } => {
            format!("now() - INTERVAL {count} {}", unit.interval())
        }
        // The only edge a caller wrote, so the only one that is bound rather
        // than written. Text, parsed by ClickHouse — so a date, a timestamp and
        // an epoch all reach the same column, and an unparseable one fails
        // loudly rather than matching nothing.
        Edge::Given(value) => binder.bind(value, ty)?,
        Edge::Less { base, unit, count } => format!(
            "({}) - INTERVAL {count} {}",
            edge_expr(binder, ty, base)?,
            unit.interval()
        ),
    })
}

/// `ts >= toStartOfMonth(now()) - INTERVAL 1 MONTH AND ts < toStartOfMonth(now())`
fn window_predicate(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    window: &Window,
) -> Result<String, String> {
    let column = column(columns, &window.column)?;
    if family(&column.r#type) != Family::Temporal {
        return Err(format!(
            "`{}` is {} — a time window needs a date or a timestamp",
            column.name, column.r#type
        ));
    }
    let ident = quote_ident(&column.name);
    let ty = one_line(&column.r#type);

    let mut parts = Vec::new();
    if let Some(from) = &window.from {
        parts.push(format!("{ident} >= {}", edge_expr(binder, &ty, from)?));
    }
    if let Some(to) = &window.to {
        // `<`, never `<=`. See [`Window`].
        parts.push(format!("{ident} < {}", edge_expr(binder, &ty, to)?));
    }
    if parts.is_empty() {
        return Err(format!(
            "this time window has neither end, so it does not narrow `{}`",
            column.name
        ));
    }
    Ok(parts.join(" AND "))
}

/// `avg(`temperature`)` — what a metric computes.
fn metric_expr(columns: &[ColumnMeta], metric: &Metric) -> Result<String, String> {
    let ident = match &metric.column {
        Some(name) => quote_ident(&column(columns, name)?.name),
        // `count()` over rows. ClickHouse spells the argument-less form with
        // nothing in the parentheses.
        None => String::new(),
    };
    Ok(metric.aggregation.call(&ident))
}

/// The expression behind one name in an aggregated answer.
///
/// Every reference to an aggregated answer's own columns goes through this, and
/// the reason is a bug only a real query showed: an alias may **shadow a real
/// column of the same name**. A bucket over `ts` is called `ts`, so `ORDER BY
/// ts` resolves to the source column, which is not in the `GROUP BY` — and
/// ClickHouse refuses a statement that reads as though it should work. The same
/// trap is waiting for a metric aliased over the column it measures.
///
/// Naming the expression instead is unambiguous everywhere, at the cost of
/// writing it twice — which costs nothing, because ClickHouse recognises the
/// subexpression it has just compiled.
fn output_expr(
    columns: &[ColumnMeta],
    aggregate: &Aggregate,
    label: Option<&Labelled>,
    name: &str,
) -> Result<Option<String>, String> {
    if let Some(label) = label {
        if label.name == name {
            return Ok(Some(label.expr.clone()));
        }
    }
    if let Some(bucket) = aggregate.buckets.iter().find(|b| b.alias == name) {
        return bucket_expr(columns, bucket).map(Some);
    }
    if let Some(dimension) = aggregate.dimensions.iter().find(|d| *d == name) {
        return column(columns, dimension).map(|c| Some(quote_ident(&c.name)));
    }
    if let Some(metric) = aggregate.metrics.iter().find(|m| m.alias == name) {
        return metric_expr(columns, metric).map(Some);
    }
    Ok(None)
}

/// `if(`ts` >= toStartOfMonth(now()), 'current', 'previous')` — which window a
/// row fell in.
///
/// Told apart by the *current* window's lower edge, which is the only test that
/// stays right for both shapes of comparison. The previous window always ends
/// where the current one begins (a period beside the one before it) or ends well
/// before it (the same period a year earlier), so nothing on the far side of
/// that edge belongs to the current window and nothing on this side belongs to
/// the previous one.
fn label_expr(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    window: &Window,
) -> Result<String, String> {
    let column = column(columns, &window.column)?;
    let from = window.from.as_ref().ok_or_else(|| {
        format!(
            "a comparison needs a window with a start, and this one leaves `{}` open at \
             the near end",
            column.name
        )
    })?;
    let ty = one_line(&column.r#type);
    Ok(format!(
        "if({} >= {}, 'current', 'previous')",
        quote_ident(&column.name),
        edge_expr(binder, &ty, from)?
    ))
}

/// The comparison's label, rendered once.
///
/// Once rather than at each of the three places that name it — the projection,
/// the `GROUP BY` and the `ORDER BY` — because rendering it again would bind its
/// values again, and because the three must agree exactly or ClickHouse groups
/// by something other than what it selected. That is the same trap the bucket
/// alias fell into, met once and handled in one place.
struct Labelled<'a> {
    name: &'a str,
    expr: String,
}

/// The rows both windows cover: either one of them.
fn windows_predicate(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    shape: &Shape,
) -> Result<Option<String>, String> {
    let mut parts = Vec::new();

    // The compared pair first, and as a pair. Every other window is a plain
    // condition on its own column — a second window narrows the answer, it does
    // not offer a second axis to compare along.
    if let Some(comparison) = &shape.compare {
        let current = window_predicate(binder, columns, &comparison.current)?;
        let previous = window_predicate(binder, columns, &comparison.previous)?;
        parts.push(format!("(({current}) OR ({previous}))"));
    }
    for window in &shape.windows {
        parts.push(window_predicate(binder, columns, window)?);
    }

    Ok(match parts.len() {
        0 => None,
        1 => Some(parts.remove(0)),
        _ => Some(format!("({})", parts.join(" AND "))),
    })
}

/// `SELECT city, avg(temperature) AS avg_temperature` — dimensions first, then
/// what is computed over them.
///
/// Every identifier still goes through [`column`], so a dimension or a metric
/// naming something the dataset does not have is refused by name here exactly
/// as a filter's column is. An alias is quoted rather than matched, because it
/// is the caller's word for their own result and the only thing that can go
/// wrong with it is the quoting.
fn group_projection(
    columns: &[ColumnMeta],
    aggregate: &Aggregate,
    label: Option<&Labelled>,
) -> Result<String, String> {
    let mut parts = Vec::new();
    if let Some(label) = label {
        parts.push(format!("{} AS {}", label.expr, quote_ident(label.name)));
    }
    for bucket in &aggregate.buckets {
        parts.push(format!(
            "{} AS {}",
            bucket_expr(columns, bucket)?,
            quote_ident(&bucket.alias)
        ));
    }
    parts.extend(
        aggregate
            .dimensions
            .iter()
            .map(|d| column(columns, d).map(|c| quote_ident(&c.name)))
            .collect::<Result<Vec<_>, _>>()?,
    );

    for metric in &aggregate.metrics {
        parts.push(format!(
            "{} AS {}",
            metric_expr(columns, metric)?,
            quote_ident(&metric.alias)
        ));
    }

    Ok(parts.join(", "))
}

/// The same rows, counted rather than returned. Deliberately without the order
/// and the projection: neither changes how many there are, and both cost.
pub fn count_around(
    inner: &str,
    shape: &Shape,
    columns: &[ColumnMeta],
    prefix: &str,
) -> Result<Wrapped, String> {
    let mut binder = Binder {
        prefix: prefix.to_string(),
        params: Vec::new(),
    };

    let mut predicates = shape
        .filters
        .iter()
        .map(|f| predicate(&mut binder, columns, f))
        .collect::<Result<Vec<_>, _>>()?;
    // The tree counts too, or a total describes a different set of rows than
    // the page it is printed beside.
    if let Some(tree) = &shape.tree {
        predicates.push(render(&mut binder, columns, tree, 0)?);
    }
    // The window counts too, for the same reason the tree does: a total beside
    // a page has to be a total of that page's rows.
    if let Some(windows) = windows_predicate(&mut binder, columns, shape)? {
        predicates.push(windows);
    }
    let filtered = if predicates.is_empty() {
        String::new()
    } else {
        format!("\nWHERE {}", predicates.join(" AND "))
    };

    let inner = inner_statement(inner);
    let sql = match &shape.aggregate {
        None => format!("SELECT count() AS total{}{filtered}", from_clause(inner)),
        Some(aggregate) => {
            // A total beside an aggregated page counts *groups*, not rows: the
            // page holds one row per city, so "how many are there" means how
            // many cities. Counting rows would print a number with nothing to
            // do with what is on the page — and it would look plausible.
            let labelled = match &shape.compare {
                Some(comparison) => Some(Labelled {
                    name: comparison.label.as_str(),
                    expr: label_expr(&mut binder, columns, &comparison.current)?,
                }),
                None => None,
            };
            // The label groups too, or the total counts each group once where
            // the page shows it twice — one row per window.
            let terms = group_terms(columns, aggregate, labelled.as_ref())?;
            if terms.is_empty() {
                return Err(
                    "this answer is a single row, so there is no total to count — drop `count`"
                        .into(),
                );
            }
            let dimensions = terms.join(", ");
            // Two levels rather than one: the groups have to be formed before
            // anything can count them, and a `GROUP BY` in the same select as
            // `count()` would collapse into counting each group's rows.
            // The `HAVING` counts too, or the total describes groups the page
            // does not show — the same mistake as counting rows instead of
            // groups, one level further in.
            let having = match &aggregate.having {
                Some(tree) => format!(
                    "\nHAVING {}",
                    render_having(&mut binder, columns, aggregate, labelled.as_ref(), tree, 0)?
                ),
                None => String::new(),
            };
            format!(
                "SELECT count() AS total\nFROM (\nSELECT {dimensions}{}{filtered}\nGROUP BY {dimensions}{having}\n)",
                from_clause(inner)
            )
        }
    };

    Ok(Wrapped {
        sql,
        params: binder.params,
        extra_columns: Vec::new(),
    })
}

/// The URL that fetches the next page, for a caller who would rather follow a
/// link than do the arithmetic. Only the shape travels: the token stays in the
/// header where it was sent, and never lands in a `Link` header a proxy logs.
pub fn next_link(path: &str, query: &[(String, String)], limit: u64, next: NextBy) -> String {
    let mut pairs: Vec<String> = query
        .iter()
        // Everything the caller sent comes across except the paging, which is
        // being replaced, and the secret, which must not end up in a `Link`
        // header that gets logged by every proxy between here and them.
        //
        // `v` deliberately stays. A pinned caller paging through an answer has
        // to keep reaching the revision they pinned to — a next link that
        // dropped it would walk page two out of whatever went live in the
        // meantime, which is the exact failure pinning exists to prevent, made
        // worse by being invisible.
        .filter(|(k, _)| !matches!(k.as_str(), "limit" | "offset" | "cursor" | "token" | "key"))
        .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
        .collect();
    pairs.push(format!("limit={limit}"));
    pairs.push(match next {
        NextBy::Offset(offset) => format!("offset={}", offset + limit),
        NextBy::Cursor(cursor) => format!("cursor={}", urlencode(&cursor)),
    });
    format!("{path}?{}", pairs.join("&"))
}

/// How the next page says where to start. A cursor where the order allows one,
/// because it is the only one of the two that cannot lose a row.
pub enum NextBy {
    Offset(u64),
    Cursor(String),
}

fn urlencode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str, ty: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            r#type: ty.into(),
        }
    }

    fn columns() -> Vec<ColumnMeta> {
        vec![
            col("city", "String"),
            col("n", "UInt32"),
            col("ts", "DateTime"),
            col("note", "Nullable(String)"),
            col("tags", "Array(String)"),
            col("id", "UUID"),
            col("a.b", "Float64"),
        ]
    }

    fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn a_statements_own_parameter_wins_over_a_reserved_name() {
        // Publishing `LIMIT {limit:UInt32}` is a reasonable thing to have done,
        // and stealing `limit` from such an endpoint would break the callers it
        // already has.
        let declared = vec!["limit".to_string()];
        let shape = parse(&q(&[("limit", "5")]), &declared, 1000).unwrap();
        assert_eq!(shape.limit, None);
        assert!(shape.filters.is_empty());
        assert_eq!(shadowed(&declared), vec!["limit".to_string()]);
    }

    #[test]
    fn a_key_that_is_neither_a_parameter_nor_reserved_is_a_filter() {
        let shape = parse(&q(&[("city", "eq.Oslo")]), &[], 1000).unwrap();
        assert_eq!(
            shape.filters,
            vec![Filter {
                column: "city".into(),
                op: Op::Eq,
                values: vec!["Oslo".into()],
            }]
        );
    }

    #[test]
    fn a_misspelt_column_is_refused_by_name_rather_than_ignored() {
        // The old rule ignored anything it did not recognise, so `citty=Oslo`
        // returned the unfiltered table and looked exactly like an answer.
        let shape = parse(&q(&[("citty", "eq.Oslo")]), &[], 1000).unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap_err();
        assert!(err.contains("citty"), "{err}");
        assert!(err.contains("city"), "{err}");
    }

    #[test]
    fn an_operator_is_never_optional() {
        // `state=in.progress` reads two ways, and picking one silently answers
        // a question nobody asked.
        let err = parse(&q(&[("state", "progress")]), &[], 1000).unwrap_err();
        assert!(err.contains("eq.progress"), "{err}");
        assert!(parse(&q(&[("state", "eq.progress")]), &[], 1000).is_ok());
    }

    #[test]
    fn an_empty_value_is_still_a_value() {
        let shape = parse(&q(&[("city", "eq.")]), &[], 1000).unwrap();
        assert_eq!(shape.filters[0].values, vec![String::new()]);
        // But an operator with nothing after it compares against nothing.
        assert!(parse(&q(&[("city", "eq")]), &[], 1000).is_err());
    }

    #[test]
    fn a_value_never_reaches_the_sql() {
        let shape = parse(&q(&[("city", "eq.O'Hare'); DROP")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT * FROM t", &shape, &columns(), Some(10), "flint_f").unwrap();
        assert!(
            wrapped.sql.contains("`city` = {flint_f0:String}"),
            "{}",
            wrapped.sql
        );
        assert!(!wrapped.sql.contains("DROP"), "{}", wrapped.sql);
        assert_eq!(
            wrapped.params,
            vec![("flint_f0".to_string(), "O'Hare'); DROP".to_string())]
        );
    }

    #[test]
    fn a_number_binds_in_its_own_type_and_a_date_through_a_parser() {
        let shape = parse(&q(&[("n", "gte.10"), ("ts", "lt.2024-01-01")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap();
        assert!(
            wrapped.sql.contains("`n` >= {p0:UInt32}"),
            "{}",
            wrapped.sql
        );
        // `parseDateTimeBestEffort`, not the `OrNull` form: an unparseable date
        // must fail rather than quietly match nothing.
        assert!(
            wrapped
                .sql
                .contains("`ts` < parseDateTimeBestEffort({p1:String})"),
            "{}",
            wrapped.sql
        );
    }

    #[test]
    fn a_type_describe_pretty_printed_comes_back_on_one_line() {
        assert_eq!(
            one_line("Tuple(\n    x UInt8,\n    y String)"),
            "Tuple(x UInt8, y String)"
        );
        assert_eq!(one_line("Nullable(String)"), "Nullable(String)");
        assert_eq!(one_line("  String  "), "String");
        assert_eq!(one_line("Decimal(18, 2)"), "Decimal(18, 2)");
    }

    #[test]
    fn nullable_and_low_cardinality_are_about_storage_not_meaning() {
        assert_eq!(base_type("LowCardinality(Nullable(String))"), "String");
        assert_eq!(family("Nullable(Decimal(18, 4))"), Family::Number);
        assert!(is_nullable("LowCardinality(Nullable(String))"));
        assert!(!is_nullable("String"));
        // `Interval` reads as a number and is not one.
        assert_eq!(family("IntervalDay"), Family::Other);
        assert_eq!(family("Enum8('a' = 1)"), Family::Text);
    }

    #[test]
    fn a_list_becomes_one_bound_parameter_per_value() {
        let shape = parse(&q(&[("city", "in.Oslo,Lyon")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap();
        assert!(
            wrapped.sql.contains("`city` IN ({p0:String}, {p1:String})"),
            "{}",
            wrapped.sql
        );
        assert_eq!(wrapped.params.len(), 2);
        assert!(parse(&q(&[("city", "in.")]), &[], 1000).is_err());
    }

    #[test]
    fn a_null_test_is_only_offered_where_a_null_can_be() {
        let shape = parse(&q(&[("note", "isnull")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap();
        assert!(wrapped.sql.contains("`note` IS NULL"), "{}", wrapped.sql);

        // On a column that cannot hold one, the filter would match nothing —
        // an empty answer that looks exactly like a true one.
        let shape = parse(&q(&[("city", "isnull")]), &[], 1000).unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap_err();
        assert!(err.contains("never be null"), "{err}");
        assert!(!ops_for("String").contains(&"isnull"));
        assert!(ops_for("Nullable(String)").contains(&"isnull"));
    }

    #[test]
    fn text_operators_are_refused_on_things_that_are_not_text() {
        let shape = parse(&q(&[("n", "like.%1%")]), &[], 1000).unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap_err();
        assert!(err.contains("compares text"), "{err}");
    }

    #[test]
    fn a_collection_is_returned_but_not_filtered_on() {
        assert!(ops_for("Array(String)").is_empty());
        let shape = parse(&q(&[("tags", "eq.a")]), &[], 1000).unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap_err();
        assert!(err.contains("not collections"), "{err}");
    }

    #[test]
    fn an_order_reads_from_the_right_and_only_when_the_tail_is_a_direction() {
        let shape = parse(&q(&[("order", "n.desc,city")]), &[], 1000).unwrap();
        assert_eq!(
            shape.order,
            vec![
                Sort {
                    column: "n".into(),
                    desc: true
                },
                Sort {
                    column: "city".into(),
                    desc: false
                },
            ]
        );
        // A column may legitimately be called `a.b`.
        let shape = parse(&q(&[("order", "a.b")]), &[], 1000).unwrap();
        assert_eq!(
            shape.order,
            vec![Sort {
                column: "a.b".into(),
                desc: false
            }]
        );
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(10), "p").unwrap();
        assert!(wrapped.sql.contains("ORDER BY `a.b`"), "{}", wrapped.sql);
    }

    #[test]
    fn a_page_is_capped_at_what_the_endpoint_serves_and_says_so() {
        let shape = parse(&q(&[("limit", "5000")]), &[], 1000).unwrap();
        assert_eq!(shape.limit, Some(1000));
        assert_eq!(shape.limit_asked, Some(5000));
        // Within the cap there is nothing to report.
        let shape = parse(&q(&[("limit", "10"), ("offset", "20")]), &[], 1000).unwrap();
        assert_eq!(shape.limit, Some(10));
        assert_eq!(shape.limit_asked, None);
        assert_eq!(shape.offset, 20);
        assert!(parse(&q(&[("limit", "0")]), &[], 1000).is_err());
        assert!(parse(&q(&[("limit", "lots")]), &[], 1000).is_err());
    }

    #[test]
    fn an_unshaped_call_is_not_wrapped_at_all() {
        // The endpoints that existed before any of this cost what they used to:
        // no subquery, and no DESCRIBE in front of them.
        let shape = parse(&q(&[("format", "csv"), ("token", "x")]), &[], 1000).unwrap();
        assert!(!shape.wraps());
        assert!(!shape.names_columns());
        // Counting needs no column names, but paging is still a wrapper.
        let shape = parse(&q(&[("count", "exact")]), &[], 1000).unwrap();
        assert!(shape.count && !shape.wraps() && !shape.names_columns());
        assert!(parse(&q(&[("count", "roughly")]), &[], 1000).is_err());
    }

    #[test]
    fn a_projection_names_columns_the_statement_returns() {
        let shape = parse(&q(&[("select", "city,n")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT * FROM t", &shape, &columns(), Some(10), "p").unwrap();
        // `FROM t`, not `FROM (SELECT * FROM t)` — see `from_clause`.
        assert!(
            wrapped.sql.starts_with("SELECT `city`, `n`\nFROM t\n"),
            "{}",
            wrapped.sql
        );
        let shape = parse(&q(&[("select", "nope")]), &[], 1000).unwrap();
        assert!(wrap("SELECT 1", &shape, &columns(), Some(10), "p").is_err());
    }

    /// A wrapper over nothing but a table says so, and a wrapper over anything
    /// else keeps its parentheses. The direction of the doubt matters: a false
    /// negative costs a pair of brackets in a statement somebody reads, and a
    /// false positive would splice unparsed text into a FROM.
    #[test]
    fn a_wrapper_over_a_plain_table_reads_as_one() {
        for (plain, expected) in [
            ("SELECT * FROM t", "\nFROM t"),
            ("SELECT * FROM db.t", "\nFROM db.t"),
            ("SELECT * FROM `db`.`t`", "\nFROM `db`.`t`"),
            ("SELECT * FROM `my db`.`t 2`", "\nFROM `my db`.`t 2`"),
            // Trailing whitespace and a semicolon are already handled for the
            // subquery form and have to be handled for this one.
            ("SELECT * FROM t;  ", "\nFROM t"),
            ("SELECT * FROM `we\\`ird`", "\nFROM `we\\`ird`"),
        ] {
            assert_eq!(from_clause(plain), expected, "{plain}");
        }

        for wrapped in [
            "SELECT 1",
            "SELECT * FROM t WHERE x = 1",
            "SELECT * FROM t FINAL",
            "SELECT * FROM t -- why",
            "SELECT * FROM numbers(10)",
            "SELECT * FROM a.b.c",
            "SELECT * FROM t AS u",
            "SELECT * FROM `unclosed",
            "SELECT * FROM ",
            "SELECT a FROM t",
            "select * from t",
        ] {
            assert!(
                from_clause(wrapped).starts_with("\nFROM (\n"),
                "{wrapped} should have kept its subquery, got {}",
                from_clause(wrapped)
            );
        }
    }

    #[test]
    fn the_statement_is_wrapped_whole() {
        // A trailing semicolon would end the statement before the parenthesis,
        // and a trailing line comment would swallow the one that closes it —
        // which is why the paren goes on its own line.
        let shape = parse(&q(&[("limit", "10")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1 -- why\n;  ", &shape, &columns(), Some(11), "p").unwrap();
        assert_eq!(
            wrapped.sql,
            "SELECT *\nFROM (\nSELECT 1 -- why\n)\nLIMIT 11"
        );
        let shape = parse(&q(&[("offset", "20")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(11), "p").unwrap();
        assert!(
            wrapped.sql.ends_with("LIMIT 11 OFFSET 20"),
            "{}",
            wrapped.sql
        );
    }

    #[test]
    fn a_count_leaves_out_what_does_not_change_the_answer() {
        let shape = parse(
            &q(&[
                ("city", "eq.Oslo"),
                ("order", "n.desc"),
                ("select", "n"),
                ("limit", "10"),
            ]),
            &[],
            1000,
        )
        .unwrap();
        let counted = count_around("SELECT * FROM t", &shape, &columns(), "p").unwrap();
        assert!(
            counted.sql.starts_with("SELECT count() AS total"),
            "{}",
            counted.sql
        );
        assert!(
            counted.sql.contains("WHERE `city` = {p0:String}"),
            "{}",
            counted.sql
        );
        assert!(!counted.sql.contains("ORDER BY"), "{}", counted.sql);
        assert!(!counted.sql.contains("LIMIT"), "{}", counted.sql);
    }

    #[test]
    fn the_binding_prefix_never_collides_with_a_declared_parameter() {
        assert_eq!(free_prefix(&[]), "flint_f");
        let declared = vec!["flint_f0".to_string()];
        let prefix = free_prefix(&declared);
        assert!(!declared.iter().any(|d| d.starts_with(&prefix)));
    }

    #[test]
    fn a_cursor_asks_for_the_rows_after_a_row_rather_than_counting_past_them() {
        let cursor = Cursor {
            order: "n.desc,city".into(),
            values: vec!["498".into(), "Oslo".into()],
        };
        let shape = parse(
            &q(&[
                ("order", "n.desc,city"),
                ("cursor", &super::super::cursor::encode(&cursor)),
            ]),
            &[],
            1000,
        )
        .unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(11), "p").unwrap();
        // Written out rather than as `(n, city) < (498, 'Oslo')`, which would
        // be the wrong claim the moment one column runs the other way.
        assert!(
            wrapped
                .sql
                .contains("((`n` < {p0:UInt32}) OR (`n` = {p1:UInt32} AND `city` > {p2:String}))"),
            "{}",
            wrapped.sql
        );
    }

    #[test]
    fn a_cursor_is_refused_where_it_would_point_somewhere_else() {
        let cursor = Cursor {
            order: "n.desc".into(),
            values: vec!["498".into()],
        };
        let encoded = super::super::cursor::encode(&cursor);

        // Without the order it was made for, it points at nothing.
        let err = parse(&q(&[("cursor", &encoded)]), &[], 1000).unwrap_err();
        assert!(err.contains("order"), "{err}");

        // With a different one, it points at a row that order never reached.
        let err = parse(&q(&[("cursor", &encoded), ("order", "city")]), &[], 1000).unwrap_err();
        assert!(err.contains("n.desc"), "{err}");

        // And both ways of saying where to start would skip a page.
        let err = parse(
            &q(&[("cursor", &encoded), ("order", "n.desc"), ("offset", "10")]),
            &[],
            1000,
        )
        .unwrap_err();
        assert!(err.contains("already says where you are"), "{err}");

        // An `.asc` written out normalises to the same signature.
        assert!(parse(
            &q(&[
                (
                    "cursor",
                    &super::super::cursor::encode(&Cursor {
                        order: "n".into(),
                        values: vec!["1".into()],
                    })
                ),
                ("order", "n.asc"),
            ]),
            &[],
            1000
        )
        .is_ok());
    }

    #[test]
    fn a_cursor_over_a_column_that_can_be_null_is_refused_by_name() {
        // A comparison against null is neither true nor false, so a keyset over
        // one silently drops every row it should have found.
        assert_eq!(
            cursor_blocker(
                &[Sort {
                    column: "note".into(),
                    desc: false
                }],
                &columns()
            ),
            Some("note".to_string())
        );
        assert_eq!(
            cursor_blocker(
                &[Sort {
                    column: "n".into(),
                    desc: false
                }],
                &columns()
            ),
            None
        );
        let cursor = Cursor {
            order: "note".into(),
            values: vec!["x".into()],
        };
        let shape = parse(
            &q(&[
                ("order", "note"),
                ("cursor", &super::super::cursor::encode(&cursor)),
            ]),
            &[],
            1000,
        )
        .unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), Some(11), "p").unwrap_err();
        assert!(err.contains("`note` can be null"), "{err}");
    }

    #[test]
    fn an_ordering_column_comes_back_even_when_the_caller_narrowed_the_columns() {
        // The cursor is made of the ordering values of the last row, so they
        // have to be in the row — and then dropped again, because `select=city`
        // that also returned `n` would answer a question nobody asked.
        let shape = parse(&q(&[("select", "city"), ("order", "n.desc")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(11), "p").unwrap();
        assert!(
            wrapped.sql.starts_with("SELECT `city`, `n`"),
            "{}",
            wrapped.sql
        );
        assert_eq!(wrapped.extra_columns, vec!["n".to_string()]);

        // Asked for explicitly, it is not an extra.
        let shape = parse(&q(&[("select", "city,n"), ("order", "n.desc")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), Some(11), "p").unwrap();
        assert!(wrapped.extra_columns.is_empty());
    }

    #[test]
    fn a_cursor_is_read_off_the_row_it_came_from() {
        let order = vec![
            Sort {
                column: "n".into(),
                desc: true,
            },
            Sort {
                column: "city".into(),
                desc: false,
            },
        ];
        let names = vec!["city".to_string(), "n".to_string()];
        let row = vec![json!("Oslo"), json!("498")];
        let cursor = cursor_for(&order, &names, &row).expect("both columns are there");
        assert_eq!(cursor.order, "n.desc,city");
        // In the order's order, not the row's.
        assert_eq!(cursor.values, vec!["498".to_string(), "Oslo".to_string()]);
        // A column the row does not carry has no cursor to give.
        assert!(cursor_for(&order, &["city".to_string()], &[json!("Oslo")]).is_none());
    }

    #[test]
    fn a_sub_second_timestamp_is_parsed_at_the_precision_it_is_kept_at() {
        // The second-resolution parser on a DateTime64(3) drops the
        // milliseconds, and a cursor built on a truncated value skips every
        // other row inside that second.
        assert_eq!(datetime64_precision("DateTime64(6, 'UTC')"), Some(6));
        assert_eq!(datetime64_precision("Nullable(DateTime64)"), Some(3));
        assert_eq!(datetime64_precision("DateTime"), None);
        let cols = vec![col("t", "DateTime64(3)")];
        let shape = parse(&q(&[("t", "gte.2024-01-01")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &cols, Some(10), "p").unwrap();
        assert!(
            wrapped
                .sql
                .contains("parseDateTime64BestEffort({p0:String}, 3)"),
            "{}",
            wrapped.sql
        );
    }

    #[test]
    fn the_next_link_prefers_a_cursor_and_drops_the_offset_it_replaces() {
        let query = q(&[("order", "n.desc"), ("offset", "40"), ("cursor", "old")]);
        let link = next_link("/api/data/x", &query, 10, NextBy::Cursor("new".into()));
        assert!(!link.contains("offset"), "{link}");
        assert!(!link.contains("old"), "{link}");
        assert!(link.ends_with("limit=10&cursor=new"), "{link}");
    }

    #[test]
    fn an_identifier_cannot_escape_its_backticks() {
        assert_eq!(quote_ident("city"), "`city`");
        assert_eq!(quote_ident("we`ird"), "`we\\`ird`");
        assert_eq!(quote_ident("back\\slash"), "`back\\\\slash`");
    }

    #[test]
    fn the_next_link_carries_the_shape_and_leaves_the_token_behind() {
        // A `Link` header lands in every proxy log between here and the caller.
        let query = q(&[
            ("token", "secret"),
            ("city", "eq.Oslo Sør"),
            ("limit", "10"),
            ("offset", "0"),
        ]);
        let link = next_link("/api/data/x", &query, 10, NextBy::Offset(0));
        assert!(!link.contains("secret"), "{link}");
        assert!(link.contains("city=eq.Oslo%20S%C3%B8r"), "{link}");
        assert!(link.ends_with("limit=10&offset=10"), "{link}");
    }

    #[test]
    fn a_next_link_drops_a_key_the_way_it_drops_a_token() {
        // Both are secrets and both travel the same three ways. A `Link`
        // header lands in every proxy log between here and the caller.
        let query = q(&[("key", "sk-live-31"), ("limit", "10")]);
        let link = next_link("/api/data/x", &query, 10, NextBy::Offset(0));
        assert!(!link.contains("sk-live-31"), "{link}");
    }

    #[test]
    fn a_next_link_stays_on_the_revision_it_was_pinned_to() {
        // A next link that dropped the pin would walk page two out of whatever
        // went live in the meantime — the exact failure pinning exists to
        // prevent, made worse by being invisible.
        let query = q(&[("v", "3"), ("limit", "10")]);
        let link = next_link("/api/data/x", &query, 10, NextBy::Offset(0));
        assert!(link.contains("v=3"), "{link}");
    }

    #[test]
    fn every_reserved_name_is_one_the_parser_also_steps_over() {
        // Two lists that have to agree: `RESERVED` is what the OpenAPI
        // document promises Flint has taken, and the match in `parse` is what
        // it has actually taken. They drifted once — `v` was added to one and
        // not the other, and the endpoint refused the pin its own document
        // told callers to send.
        for name in RESERVED {
            // A reserved name may still refuse the *value* — `cursor=1` is not
            // a cursor Flint issued, and saying so is right. What it may never
            // do is fall through to the filter parser, whose refusal talks
            // about operators and sends the caller looking for a column.
            match parse(&q(&[(name, "1")]), &[], 100) {
                Ok(shape) => assert!(
                    shape.filters.iter().all(|f| f.column != **name),
                    "`{name}` is reserved and was still read as a filter"
                ),
                Err(said) => assert!(
                    !said.contains("needs an operator"),
                    "`{name}` is reserved and was still read as a filter: {said}"
                ),
            }
        }
    }

    #[test]
    fn the_pin_and_the_key_are_not_read_as_filters() {
        // Left off `RESERVED`, `?v=4` was parsed as a filter on a column named
        // `v` and answered 400 with a sentence about operators — to a caller
        // who had done nothing wrong.
        for name in ["v", "key"] {
            assert!(
                RESERVED.contains(&name),
                "`{name}` is read before the shape is parsed and must not be a filter"
            );
        }
    }
}
