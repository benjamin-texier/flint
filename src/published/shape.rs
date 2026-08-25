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

    fn from_keyword(word: &str) -> Option<Op> {
        Op::ALL.into_iter().find(|op| op.keyword() == word)
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
    const fn takes_value(self) -> bool {
        !matches!(self, Op::IsNull | Op::NotNull)
    }

    const fn takes_list(self) -> bool {
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
            // Read by the handler, which knows about tokens and content types.
            "token" | "format" => continue,
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
        let known = columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!("`{name}` is not a column this endpoint returns; it has {known}")
    })
}

/// One value, bound in whatever type the column will actually compare against.
fn value_expr(binder: &mut Binder, col: &ColumnMeta, value: &str) -> Result<String, String> {
    match family(&col.r#type) {
        Family::Text => binder.bind(value, "String"),
        Family::Number | Family::Native => binder.bind(value, base_type(&col.r#type)),
        // `parseDateTimeBestEffort`, not the `OrNull` form: an unparseable date
        // must fail loudly. The `OrNull` version turns `?ts=gte.yesterday` into
        // a NULL comparison, which matches no rows — an empty answer that looks
        // exactly like a true one.
        Family::Temporal => Ok(temporal_parse(&col.r#type, &binder.bind(value, "String")?)),
        Family::Other => Err(format!(
            "`{}` is {} — this endpoint filters on single values, not collections",
            col.name, col.r#type
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
            let col = column(columns, &earlier.column)?;
            conjunction.push(format!(
                "{} = {}",
                quote_ident(&col.name),
                value_expr(binder, col, value)?
            ));
        }
        let col = column(columns, &sort.column)?;
        conjunction.push(format!(
            "{} {} {}",
            quote_ident(&col.name),
            if sort.desc { "<" } else { ">" },
            value_expr(binder, col, &values[i])?
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

fn predicate(
    binder: &mut Binder,
    columns: &[ColumnMeta],
    filter: &Filter,
) -> Result<String, String> {
    let col = column(columns, &filter.column)?;
    let ident = quote_ident(&col.name);

    if !filter.op.takes_value() {
        if !is_nullable(&col.r#type) {
            return Err(format!(
                "`{}` is {} and can never be null, so `{}` would match nothing",
                col.name,
                col.r#type,
                filter.op.keyword()
            ));
        }
        return Ok(format!("{ident} {}", filter.op.infix()));
    }

    if matches!(filter.op, Op::Like | Op::ILike) && family(&col.r#type) != Family::Text {
        return Err(format!(
            "`{}` is {} — `{}` compares text",
            col.name,
            col.r#type,
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
pub fn wrap(
    inner: &str,
    shape: &Shape,
    columns: &[ColumnMeta],
    fetch: u64,
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
    let mut extra_columns = Vec::new();
    let projection = if shape.select.is_empty() {
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

    let mut sql = format!("SELECT {projection}\nFROM (\n{}\n)", inner_statement(inner));

    let mut predicates = shape
        .filters
        .iter()
        .map(|f| predicate(&mut binder, columns, f))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(cursor) = &shape.cursor {
        predicates.push(keyset(&mut binder, columns, &shape.order, &cursor.values)?);
    }
    if !predicates.is_empty() {
        sql.push_str(&format!("\nWHERE {}", predicates.join(" AND ")));
    }

    if !shape.order.is_empty() {
        let terms = shape
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
            .collect::<Result<Vec<_>, _>>()?;
        sql.push_str(&format!("\nORDER BY {}", terms.join(", ")));
    }

    sql.push_str(&format!("\nLIMIT {fetch}"));
    if shape.offset > 0 {
        sql.push_str(&format!(" OFFSET {}", shape.offset));
    }

    Ok(Wrapped {
        sql,
        params: binder.params,
        extra_columns,
    })
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
    let mut sql = format!(
        "SELECT count() AS total\nFROM (\n{}\n)",
        inner_statement(inner)
    );
    let predicates = shape
        .filters
        .iter()
        .map(|f| predicate(&mut binder, columns, f))
        .collect::<Result<Vec<_>, _>>()?;
    if !predicates.is_empty() {
        sql.push_str(&format!("\nWHERE {}", predicates.join(" AND ")));
    }
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
        .filter(|(k, _)| !matches!(k.as_str(), "limit" | "offset" | "cursor" | "token"))
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
        let err = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap_err();
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
        let wrapped = wrap("SELECT * FROM t", &shape, &columns(), 10, "flint_f").unwrap();
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
        let wrapped = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap();
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
        let wrapped = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap();
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
        let wrapped = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap();
        assert!(wrapped.sql.contains("`note` IS NULL"), "{}", wrapped.sql);

        // On a column that cannot hold one, the filter would match nothing —
        // an empty answer that looks exactly like a true one.
        let shape = parse(&q(&[("city", "isnull")]), &[], 1000).unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap_err();
        assert!(err.contains("never be null"), "{err}");
        assert!(!ops_for("String").contains(&"isnull"));
        assert!(ops_for("Nullable(String)").contains(&"isnull"));
    }

    #[test]
    fn text_operators_are_refused_on_things_that_are_not_text() {
        let shape = parse(&q(&[("n", "like.%1%")]), &[], 1000).unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap_err();
        assert!(err.contains("compares text"), "{err}");
    }

    #[test]
    fn a_collection_is_returned_but_not_filtered_on() {
        assert!(ops_for("Array(String)").is_empty());
        let shape = parse(&q(&[("tags", "eq.a")]), &[], 1000).unwrap();
        let err = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap_err();
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
        let wrapped = wrap("SELECT 1", &shape, &columns(), 10, "p").unwrap();
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
        let wrapped = wrap("SELECT * FROM t", &shape, &columns(), 10, "p").unwrap();
        assert!(
            wrapped.sql.starts_with("SELECT `city`, `n`\nFROM ("),
            "{}",
            wrapped.sql
        );
        let shape = parse(&q(&[("select", "nope")]), &[], 1000).unwrap();
        assert!(wrap("SELECT 1", &shape, &columns(), 10, "p").is_err());
    }

    #[test]
    fn the_statement_is_wrapped_whole() {
        // A trailing semicolon would end the statement before the parenthesis,
        // and a trailing line comment would swallow the one that closes it —
        // which is why the paren goes on its own line.
        let shape = parse(&q(&[("limit", "10")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1 -- why\n;  ", &shape, &columns(), 11, "p").unwrap();
        assert_eq!(
            wrapped.sql,
            "SELECT *\nFROM (\nSELECT 1 -- why\n)\nLIMIT 11"
        );
        let shape = parse(&q(&[("offset", "20")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), 11, "p").unwrap();
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
        let wrapped = wrap("SELECT 1", &shape, &columns(), 11, "p").unwrap();
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
        let err = wrap("SELECT 1", &shape, &columns(), 11, "p").unwrap_err();
        assert!(err.contains("`note` can be null"), "{err}");
    }

    #[test]
    fn an_ordering_column_comes_back_even_when_the_caller_narrowed_the_columns() {
        // The cursor is made of the ordering values of the last row, so they
        // have to be in the row — and then dropped again, because `select=city`
        // that also returned `n` would answer a question nobody asked.
        let shape = parse(&q(&[("select", "city"), ("order", "n.desc")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), 11, "p").unwrap();
        assert!(
            wrapped.sql.starts_with("SELECT `city`, `n`"),
            "{}",
            wrapped.sql
        );
        assert_eq!(wrapped.extra_columns, vec!["n".to_string()]);

        // Asked for explicitly, it is not an extra.
        let shape = parse(&q(&[("select", "city,n"), ("order", "n.desc")]), &[], 1000).unwrap();
        let wrapped = wrap("SELECT 1", &shape, &columns(), 11, "p").unwrap();
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
        let wrapped = wrap("SELECT 1", &shape, &cols, 10, "p").unwrap();
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
}
