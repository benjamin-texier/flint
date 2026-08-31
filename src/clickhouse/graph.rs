//! The schema graph: which objects read from which.
//!
//! ClickHouse only tracks one of these edges for you. `system.tables`
//! maintains `dependencies_*` for materialized views, and nothing else — plain
//! views, a materialized view's target table and a dictionary's source are all
//! recorded only inside the object's own DDL. So the rest is recovered by
//! reading those definitions, and every candidate is checked against the set of
//! objects that actually exist before it becomes an edge. That last step is
//! what keeps aliases, CTE names and table functions like `numbers(10)` out of
//! the diagram.
//!
//! One more thing is recovered here: a materialized view created without a TO
//! clause gets a storage table ClickHouse names after the view's uuid. Those
//! are not objects anybody wrote, and drawn as nodes they double every such
//! view and label half of them with a uuid. So each one is folded into the view
//! that owns it — edges that touched the storage are redrawn to touch the view,
//! and its rows and bytes are counted as the view's, since that is where they
//! came from.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::meta::{classify, TableSummary};
use super::{Client, QueryOptions};
use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub database: String,
    pub name: String,
    pub kind: String,
    pub engine: String,
    pub comment: String,
    pub rows: u64,
    pub bytes: u64,
    pub columns: u64,
    /// True when the object lives outside the database being viewed. Those are
    /// drawn differently: they are context, not content.
    pub external: bool,
}

/// How one object relates to another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// `to` selects from `from` — a view or materialized view over a table.
    Reads,
    /// `from` is a materialized view whose rows land in `to`.
    Writes,
    /// `to` is a dictionary loading from `from`.
    Loads,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaGraph {
    pub database: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// `database.name`, the id used to join nodes and edges.
fn id(database: &str, name: &str) -> String {
    format!("{database}.{name}")
}

#[derive(Deserialize)]
struct DefinitionRow {
    database: String,
    name: String,
    engine: String,
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    create_query: String,
    #[serde(default)]
    as_select: String,
    #[serde(default)]
    dependencies_database: Vec<String>,
    #[serde(default)]
    dependencies_table: Vec<String>,
}

pub async fn schema_graph(ch: &Client, database: &str) -> Result<SchemaGraph> {
    let summaries = super::meta::tables(ch, database).await?;

    // Definitions for every object an edge could touch: the database being
    // viewed, plus the user's other databases, since an edge may point at a
    // table elsewhere and that node has to exist for the edge to be drawn.
    //
    // ClickHouse's own databases are skipped *unless* they are the one being
    // viewed — `system` alone holds well over a hundred tables and scanning
    // them to find edges nobody asked about is pure cost.
    let as_select = ch.col_or("tables", "as_select", "''").await?;
    let uuid = ch.col_or("tables", "uuid", "''").await?;
    let definitions: Vec<DefinitionRow> = ch
        .rows_with(
            &format!(
                "SELECT database              AS database, \
                        name                   AS name, \
                        engine                 AS engine, \
                        toString({uuid})       AS uuid, \
                        create_table_query     AS create_query, \
                        {as_select}            AS as_select, \
                        dependencies_database  AS dependencies_database, \
                        dependencies_table     AS dependencies_table \
                 FROM system.tables \
                 WHERE database = {{db:String}} \
                    OR database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')",
            ),
            QueryOptions {
                params: vec![("db".into(), database.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;

    let existing: HashSet<String> = definitions
        .iter()
        .map(|d| id(&d.database, &d.name))
        .collect();
    // Which materialized view owns each storage table ClickHouse created for
    // one. Keyed both ways round: `.inner_id.<uuid>` names the view by its
    // uuid, the older `.inner.<view>` by its name.
    let mv_by_uuid: HashMap<&str, &DefinitionRow> = definitions
        .iter()
        .filter(|d| classify(&d.engine) == "materialized_view" && !d.uuid.is_empty())
        .map(|d| (d.uuid.as_str(), d))
        .collect();

    let owner_of: HashMap<String, String> = definitions
        .iter()
        .filter_map(|d| {
            let owner = match storage_of(&d.name)? {
                Storage::Uuid(u) => {
                    let mv = mv_by_uuid.get(u)?;
                    id(&mv.database, &mv.name)
                }
                Storage::Named(n) => {
                    let candidate = id(&d.database, n);
                    existing.contains(&candidate).then_some(candidate)?
                }
            };
            Some((id(&d.database, &d.name), owner))
        })
        .collect();

    let by_name: HashMap<&str, Vec<&DefinitionRow>> = definitions.iter().fold(
        HashMap::new(),
        |mut acc: HashMap<&str, Vec<&DefinitionRow>>, d| {
            acc.entry(d.name.as_str()).or_default().push(d);
            acc
        },
    );

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut seen: HashSet<(String, String, EdgeKind)> = HashSet::new();
    let mut push = |from: String, to: String, kind: EdgeKind| {
        // Whatever an edge was pointing at, it is really about the object
        // somebody made. A view writing into its own storage becomes a
        // self-edge and is dropped just below.
        let from = owner_of.get(&from).cloned().unwrap_or(from);
        let to = owner_of.get(&to).cloned().unwrap_or(to);
        if from == to {
            return;
        }
        if seen.insert((from.clone(), to.clone(), kind)) {
            edges.push(GraphEdge { from, to, kind });
        }
    };

    for def in &definitions {
        let self_id = id(&def.database, &def.name);

        // 1. Materialized-view dependencies, straight from ClickHouse: each
        //    entry is an object that reads from this one.
        for (dep_db, dep_name) in def
            .dependencies_database
            .iter()
            .zip(def.dependencies_table.iter())
        {
            let dependent = id(dep_db, dep_name);
            if existing.contains(&dependent) {
                push(self_id.clone(), dependent, EdgeKind::Reads);
            }
        }

        match classify(&def.engine) {
            // 2. A materialized view's rows land in its TO target.
            "materialized_view" => {
                if let Some(target) = target_of(&def.create_query, &def.database) {
                    if existing.contains(&target) {
                        push(self_id.clone(), target, EdgeKind::Writes);
                    }
                }
                // The dependency edge above covers the source side, but a view
                // created before its source was tracked can be missing it.
                for source in references(&def.as_select, &def.database, &by_name, &existing) {
                    push(source, self_id.clone(), EdgeKind::Reads);
                }
            }
            // 3. A dictionary's source table, from SOURCE(CLICKHOUSE(...)).
            "dictionary" => {
                if let Some(source) = dictionary_source(&def.create_query, &def.database) {
                    if existing.contains(&source) {
                        push(source, self_id.clone(), EdgeKind::Loads);
                    }
                }
            }
            // 4. Plain views: ClickHouse tracks nothing, so read the SELECT.
            "view" => {
                let definition = if def.as_select.is_empty() {
                    def.create_query.as_str()
                } else {
                    def.as_select.as_str()
                };
                for source in references(definition, &def.database, &by_name, &existing) {
                    push(source, self_id.clone(), EdgeKind::Reads);
                }
            }
            _ => {}
        }
    }

    // Keep the database in view, plus anything an edge reaches into.
    let mut wanted: HashSet<String> = summaries
        .iter()
        .map(|t| id(database, &t.name))
        .filter(|node| !owner_of.contains_key(node))
        .collect();
    let local = wanted.clone();
    edges.retain(|e| local.contains(&e.from) || local.contains(&e.to));
    for edge in &edges {
        wanted.insert(edge.from.clone());
        wanted.insert(edge.to.clone());
    }

    let summaries_by_name: HashMap<&str, &TableSummary> =
        summaries.iter().map(|t| (t.name.as_str(), t)).collect();

    // The storage's figures, gathered under the view that owns it: a
    // materialized view reports nothing for itself, but the disk it costs is
    // real and it is the view somebody would ask about.
    let mut stored: HashMap<&str, (u64, u64)> = HashMap::new();
    for t in &summaries {
        if let Some(owner) = owner_of.get(&id(database, &t.name)) {
            let entry = stored.entry(owner.as_str()).or_default();
            entry.0 += t.total_rows.unwrap_or(t.parts_rows);
            entry.1 += t.total_bytes.unwrap_or(t.parts_bytes);
        }
    }

    let mut nodes: Vec<GraphNode> = Vec::new();
    for def in &definitions {
        let node_id = id(&def.database, &def.name);
        if !wanted.contains(&node_id) {
            continue;
        }
        let summary = if def.database == database {
            summaries_by_name.get(def.name.as_str()).copied()
        } else {
            None
        };
        let own = stored.get(node_id.as_str()).copied().unwrap_or((0, 0));
        nodes.push(GraphNode {
            database: def.database.clone(),
            name: def.name.clone(),
            kind: classify(&def.engine).to_string(),
            engine: def.engine.clone(),
            comment: summary.map(|s| s.comment.clone()).unwrap_or_default(),
            rows: summary
                .and_then(|s| s.total_rows.or(Some(s.parts_rows)))
                .filter(|rows| *rows > 0)
                .unwrap_or(own.0),
            bytes: summary
                .and_then(|s| s.total_bytes.or(Some(s.parts_bytes)))
                .filter(|bytes| *bytes > 0)
                .unwrap_or(own.1),
            columns: summary.map(|s| s.columns).unwrap_or(0),
            external: def.database != database,
        });
    }
    nodes.sort_by(|a, b| a.database.cmp(&b.database).then(a.name.cmp(&b.name)));

    Ok(SchemaGraph {
        database: database.to_string(),
        nodes,
        edges,
    })
}

/// The view a storage table belongs to, as ClickHouse names it.
enum Storage<'a> {
    /// `.inner_id.<uuid>` — the modern name, keyed on the view's uuid.
    Uuid(&'a str),
    /// `.inner.<view>` — the pre-20.x name, keyed on the view's own name.
    Named(&'a str),
}

/// Whether a table is storage ClickHouse created for a materialized view, and
/// which view to look for. Names are matched exactly: a table somebody called
/// `inner_events` is theirs, not ClickHouse's.
fn storage_of(name: &str) -> Option<Storage<'_>> {
    if let Some(uuid) = name.strip_prefix(".inner_id.") {
        return (!uuid.is_empty()).then_some(Storage::Uuid(uuid));
    }
    let view = name.strip_prefix(".inner.")?;
    (!view.is_empty()).then_some(Storage::Named(view))
}

/// `CREATE MATERIALIZED VIEW x TO db.table (...)` → `db.table`.
pub fn target_of(create_query: &str, default_database: &str) -> Option<String> {
    let rest = create_query.split(" TO ").nth(1)?;
    let (first, second) = qualified_name(rest.trim_start())?;
    Some(match second {
        Some(name) => id(&first, &name),
        None => id(default_database, &first),
    })
}

/// `SOURCE(CLICKHOUSE(TABLE 'cities' DB 'reference'))` → `reference.cities`.
///
/// `system.dictionaries.source` would be the obvious place to read this, but it
/// stays empty until the dictionary is first loaded, and a dictionary nobody
/// has queried yet still belongs on the diagram.
fn dictionary_source(create_query: &str, default_database: &str) -> Option<String> {
    let source = create_query.split("SOURCE(").nth(1)?;
    let quoted = |key: &str| -> Option<String> {
        let after = source.split(&format!("{key} ")).nth(1)?;
        let value = after.trim_start().strip_prefix('\'')?;
        Some(value.split('\'').next()?.to_string())
    };
    let table = quoted("TABLE")?;
    Some(id(
        &quoted("DB").unwrap_or_else(|| default_database.to_string()),
        &table,
    ))
}

/// Read an optionally-backticked, optionally-qualified name off the front of
/// `text`, returning `(first, second)` where `second` is the part after a dot.
fn qualified_name(text: &str) -> Option<(String, Option<String>)> {
    let (first, rest) = one_name(text)?;
    let rest = rest.trim_start();
    if let Some(after_dot) = rest.strip_prefix('.') {
        if let Some((second, _)) = one_name(after_dot.trim_start()) {
            return Some((first, Some(second)));
        }
    }
    Some((first, None))
}

fn one_name(text: &str) -> Option<(String, &str)> {
    let bytes = text.as_bytes();
    if bytes.first() == Some(&b'`') {
        let end = text[1..].find('`')? + 1;
        return Some((text[1..end].to_string(), &text[end + 1..]));
    }
    let end = text
        .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
        .unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    Some((text[..end].to_string(), &text[end..]))
}

/// Every real object a SELECT reads from.
///
/// This is deliberately not a SQL parser. It collects every name that follows
/// `FROM` or `JOIN` and then discards the ones that do not name an object that
/// exists, which is what makes it safe: an alias, a CTE or `numbers(10)` simply
/// fails to match and disappears.
fn references(
    definition: &str,
    default_database: &str,
    by_name: &HashMap<&str, Vec<&DefinitionRow>>,
    existing: &HashSet<String>,
) -> Vec<String> {
    let cleaned = strip_noise(definition);
    let lowered = cleaned.to_ascii_lowercase();
    let mut found = Vec::new();

    for keyword in ["from", "join"] {
        let mut at = 0;
        while let Some(offset) = lowered[at..].find(keyword) {
            let start = at + offset;
            at = start + keyword.len();

            // Only a standalone keyword counts, so `from` inside `fromUnixTime`
            // is ignored.
            let before_ok = start == 0
                || !lowered.as_bytes()[start - 1].is_ascii_alphanumeric()
                    && lowered.as_bytes()[start - 1] != b'_';
            let after = &cleaned[at..];
            if !before_ok || !after.starts_with(|c: char| c.is_whitespace()) {
                continue;
            }

            if let Some((first, second)) = qualified_name(after.trim_start()) {
                match second {
                    // Qualified: accept only if that exact object exists.
                    Some(name) => {
                        let candidate = id(&first, &name);
                        if existing.contains(&candidate) {
                            found.push(candidate);
                        }
                    }
                    // Bare: prefer the view's own database, then a unique match
                    // elsewhere. An ambiguous bare name is left out rather than
                    // guessed at.
                    None => {
                        let same_db = id(default_database, &first);
                        if existing.contains(&same_db) {
                            found.push(same_db);
                        } else if let Some(matches) = by_name.get(first.as_str()) {
                            if matches.len() == 1 {
                                let only = matches[0];
                                found.push(id(&only.database, &only.name));
                            }
                        }
                    }
                }
            }
        }
    }
    found
}

/// Remove comments and string literals so a `FROM` inside either is not read
/// as a table reference.
fn strip_noise(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        match c {
            '-' if chars.peek().map(|(_, n)| *n) == Some('-') => {
                for (_, n) in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek().map(|(_, n)| *n) == Some('*') => {
                let mut prev = ' ';
                for (_, n) in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
                out.push(' ');
            }
            '\'' => {
                let mut escaped = false;
                for (_, n) in chars.by_ref() {
                    if escaped {
                        escaped = false;
                        continue;
                    }
                    if n == '\\' {
                        escaped = true;
                        continue;
                    }
                    if n == '\'' {
                        break;
                    }
                }
                out.push_str("''");
            }
            other => out.push(other),
        }
    }
    out
}

/// One thing a drop would break.
#[derive(Debug, Clone, Serialize)]
pub struct Dependent {
    pub qualified: String,
    /// `materialized_view`, `view`, `dictionary` — what it is, so the reader can
    /// judge how much it matters.
    pub kind: String,
    /// How Flint knows. Two very different claims, and conflating them would be
    /// the worst thing this endpoint could do:
    ///
    /// - `declared` — ClickHouse's own `dependencies_table`. The server will
    ///   itself refuse or break; this is not an opinion.
    /// - `inferred` — the object's definition names the table. Read by the same
    ///   deliberately-not-a-parser that draws the schema diagram, so it can miss
    ///   a reference built by string concatenation, and it can catch one inside a
    ///   comment.
    pub how: &'static str,
}

/// What a drop would take with it.
#[derive(Debug, Clone, Serialize)]
pub struct Impact {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub qualified: String,
    /// What is in the table itself. The figure a confirmation has to carry: an
    /// object list without it says what breaks and not what is lost.
    pub rows: u64,
    pub bytes: u64,
    /// Everything that reads it, directly or through another view. Ordered
    /// declared-first, because that is the half nobody can argue with.
    pub dependents: Vec<Dependent>,
    /// True where the dependent list is complete as far as ClickHouse is
    /// concerned. False when a grant stopped Flint from reading definitions, in
    /// which case an empty list means "unknown" rather than "nothing".
    pub complete: bool,
}

/// Everything that would break if `database.table` went away.
///
/// Two passes, kept apart. ClickHouse's `dependencies_table` is authoritative and
/// covers materialized views — the server registers those. It does *not* cover an
/// ordinary view, whose reference is resolved when the view is queried, so those
/// are found by reading definitions the way the diagram does.
///
/// Transitive, and it has to be: a view over a view over the table breaks too,
/// and a confirmation that showed only the first hop would understate the damage
/// on exactly the schemas where it matters most.
pub async fn impact(ch: &Client, database: &str, table: &str) -> Result<Impact> {
    let target = id(database, table);

    if let super::Reach::Denied = ch.reach("tables").await? {
        return Ok(Impact {
            available: false,
            reason: Some(
                "this user cannot read system.tables, so Flint cannot say what depends on it"
                    .into(),
            ),
            qualified: target,
            rows: 0,
            bytes: 0,
            dependents: Vec::new(),
            complete: false,
        });
    }

    // Every definition the user can see, once. The traversal needs all of them:
    // a view in another database can read this table, and a confirmation that
    // looked only in one database would miss it — which is the case where being
    // wrong costs the most.
    //
    // The same filter the diagram uses: ClickHouse's own databases are skipped
    // unless the table is in one, because `system` alone holds well over a
    // hundred objects and nothing there reads a user's table.
    let uuid = ch.col_or("tables", "uuid", "''").await?;
    let rows: Vec<DefinitionRow> = ch
        .rows_with(
            &format!(
                "SELECT database              AS database, \
                        name                   AS name, \
                        engine                 AS engine, \
                        toString({uuid})       AS uuid, \
                        create_table_query     AS create_query, \
                        dependencies_database  AS dependencies_database, \
                        dependencies_table     AS dependencies_table \
                 FROM system.tables \
                 WHERE database = {{db:String}} \
                    OR database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')"
            ),
            QueryOptions {
                params: vec![("db".into(), database.to_string())],
                ..QueryOptions::internal()
            },
        )
        .await?;

    let existing: HashSet<String> = rows.iter().map(|r| id(&r.database, &r.name)).collect();
    let mut by_name: HashMap<&str, Vec<&DefinitionRow>> = HashMap::new();
    for row in &rows {
        by_name.entry(row.name.as_str()).or_default().push(row);
    }

    // Who reads whom, and how Flint knows.
    //
    // A map per source rather than a list, because a reader can be found twice —
    // once because ClickHouse declared it and once because its definition names
    // the table — and the label must not depend on which arrived first. It did:
    // whichever the server happened to return earlier won, so of three declared
    // materialized views one came out `declared` and two `inferred`, on the same
    // data, for no reason a reader could ever have guessed. `declared` always
    // wins now.
    let mut reads: HashMap<String, HashMap<String, &'static str>> = HashMap::new();
    let mut note = |source: String, reader: String, how: &'static str| {
        let entry = reads.entry(source).or_default();
        match entry.get(&reader) {
            Some(&"declared") => {}
            _ => {
                entry.insert(reader, how);
            }
        }
    };
    for row in &rows {
        let me = id(&row.database, &row.name);
        for (db, name) in row
            .dependencies_database
            .iter()
            .zip(row.dependencies_table.iter())
        {
            // `dependencies_table` on X lists the things that depend on X — so
            // the key is X and the value is the dependent, not the other way
            // round. Getting this backwards still produced the right *set*,
            // because the inferred pass found the same objects; it only
            // mislabelled how Flint knew, which is the one thing this endpoint
            // must not get wrong.
            note(me.clone(), id(db, name), "declared");
        }
        if !row.create_query.is_empty() {
            for source in references(&row.create_query, &row.database, &by_name, &existing) {
                if source != me {
                    note(source, me.clone(), "inferred");
                }
            }
        }
    }

    // Breadth-first from the table outwards, so a view over a view is included
    // and a cycle cannot spin.
    let kinds: HashMap<&str, &str> = rows
        .iter()
        .map(|r| (r.name.as_str(), r.engine.as_str()))
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue = vec![target.clone()];
    let mut dependents: Vec<Dependent> = Vec::new();

    while let Some(current) = queue.pop() {
        let Some(readers) = reads.get(&current) else {
            continue;
        };
        // Cloned because the walk pushes onto its own queue while reading this.
        let readers: Vec<(String, &'static str)> =
            readers.iter().map(|(r, h)| (r.clone(), *h)).collect();
        for (reader, how) in readers {
            if reader == target || !seen.insert(reader.clone()) {
                continue;
            }
            let short = reader.rsplit('.').next().unwrap_or(&reader);
            dependents.push(Dependent {
                qualified: reader.clone(),
                kind: kind_of(kinds.get(short).copied().unwrap_or("")),
                how,
            });
            queue.push(reader);
        }
    }

    // Declared first: it is the half nobody can argue with, and a reader
    // skimming the list should meet the certain damage before the inferred.
    dependents.sort_by(|a, b| {
        (a.how != "declared", a.qualified.clone()).cmp(&(b.how != "declared", b.qualified.clone()))
    });

    let (rows_count, bytes) = table_size(ch, database, table).await?;
    Ok(Impact {
        available: true,
        reason: None,
        qualified: target,
        rows: rows_count,
        bytes,
        dependents,
        complete: true,
    })
}

/// What the object is, in Flint's vocabulary rather than the engine's.
fn kind_of(engine: &str) -> String {
    match engine {
        "MaterializedView" => "materialized view".into(),
        "View" => "view".into(),
        "Dictionary" => "dictionary".into(),
        "" => "object".into(),
        other => other.to_string(),
    }
}

/// What is in the table now. Zero for a view, which stores nothing — and that is
/// a real answer, not a missing one.
async fn table_size(ch: &Client, database: &str, table: &str) -> Result<(u64, u64)> {
    #[derive(Deserialize)]
    struct Row {
        rows: u64,
        bytes: u64,
    }
    let row: Option<Row> = ch
        .row_with(
            "SELECT toUInt64(sum(rows)) AS rows, toUInt64(sum(bytes_on_disk)) AS bytes \
             FROM system.parts \
             WHERE active AND database = {db:String} AND table = {tbl:String}",
            QueryOptions {
                params: vec![
                    ("db".into(), database.to_string()),
                    ("tbl".into(), table.to_string()),
                ],
                ..QueryOptions::internal()
            },
        )
        .await?;
    Ok(row.map(|r| (r.rows, r.bytes)).unwrap_or((0, 0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_index() -> (
        HashMap<&'static str, Vec<&'static DefinitionRow>>,
        HashSet<String>,
    ) {
        (HashMap::new(), HashSet::new())
    }

    #[test]
    fn reads_a_materialized_view_target() {
        let q = "CREATE MATERIALIZED VIEW analytics.hourly_mv TO analytics.hourly_rollup (`hour` DateTime) AS SELECT 1";
        assert_eq!(
            target_of(q, "analytics").as_deref(),
            Some("analytics.hourly_rollup")
        );
    }

    #[test]
    fn a_bare_target_takes_the_views_database() {
        let q = "CREATE MATERIALIZED VIEW analytics.mv TO rollup (`x` UInt8) AS SELECT 1";
        assert_eq!(
            target_of(q, "analytics").as_deref(),
            Some("analytics.rollup")
        );
    }

    #[test]
    fn a_view_without_a_target_has_none() {
        let q = "CREATE MATERIALIZED VIEW analytics.mv ENGINE = MergeTree AS SELECT 1";
        assert_eq!(target_of(q, "analytics"), None);
    }

    #[test]
    fn reads_a_dictionary_source() {
        let q = "CREATE DICTIONARY reference.city_region (`city` String) PRIMARY KEY city \
                 SOURCE(CLICKHOUSE(TABLE 'cities' DB 'reference')) LIFETIME(MIN 0 MAX 600)";
        assert_eq!(
            dictionary_source(q, "reference").as_deref(),
            Some("reference.cities")
        );
    }

    #[test]
    fn a_dictionary_source_without_a_db_uses_its_own() {
        let q = "CREATE DICTIONARY d (`x` String) PRIMARY KEY x SOURCE(CLICKHOUSE(TABLE 'src'))";
        assert_eq!(dictionary_source(q, "mine").as_deref(), Some("mine.src"));
    }

    #[test]
    fn a_non_clickhouse_dictionary_source_yields_nothing() {
        let q = "CREATE DICTIONARY d (`x` String) PRIMARY KEY x SOURCE(HTTP(URL 'http://x'))";
        assert_eq!(dictionary_source(q, "mine"), None);
    }

    #[test]
    fn parses_backticked_and_qualified_names() {
        assert_eq!(
            qualified_name("`my db`.`odd name` (rest"),
            Some(("my db".into(), Some("odd name".into())))
        );
        assert_eq!(qualified_name("plain rest"), Some(("plain".into(), None)));
        assert_eq!(qualified_name("(nope"), None);
    }

    #[test]
    fn strips_comments_and_string_literals() {
        assert_eq!(strip_noise("a -- FROM x\nb"), "a \nb");
        // The comment collapses to one space, between the two that surround it.
        assert_eq!(strip_noise("a /* FROM x */ b"), "a   b");
        assert_eq!(strip_noise("a 'FROM x' b"), "a '' b");
        assert_eq!(strip_noise("a '\\'' b"), "a '' b");
    }

    /// Builds the index that `references` checks candidates against.
    fn index(objects: &[(&str, &str)]) -> HashSet<String> {
        objects.iter().map(|(d, n)| id(d, n)).collect()
    }

    #[test]
    fn finds_qualified_and_bare_references() {
        let existing = index(&[("analytics", "events"), ("analytics", "devices")]);
        let by_name = HashMap::new();
        let found = references(
            "SELECT * FROM analytics.events AS e LEFT JOIN devices AS d ON d.id = e.id",
            "analytics",
            &by_name,
            &existing,
        );
        assert!(found.contains(&"analytics.events".to_string()));
        assert!(found.contains(&"analytics.devices".to_string()));
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn recognises_the_storage_clickhouse_names_itself() {
        assert!(matches!(
            storage_of(".inner_id.3f49bf7f-aeb7-4931-b21f-cdc3ea412e03"),
            Some(Storage::Uuid("3f49bf7f-aeb7-4931-b21f-cdc3ea412e03"))
        ));
        assert!(matches!(
            storage_of(".inner.daily_totals"),
            Some(Storage::Named("daily_totals"))
        ));
    }

    #[test]
    fn leaves_tables_somebody_named_alone() {
        assert!(storage_of("inner_events").is_none());
        assert!(storage_of("events").is_none());
        // A prefix and nothing else names no view.
        assert!(storage_of(".inner_id.").is_none());
        assert!(storage_of(".inner.").is_none());
    }

    #[test]
    fn discards_aliases_and_table_functions() {
        let existing = index(&[("analytics", "events")]);
        let by_name = HashMap::new();
        let found = references(
            "SELECT * FROM numbers(10) UNION ALL SELECT * FROM events",
            "analytics",
            &by_name,
            &existing,
        );
        assert_eq!(found, vec!["analytics.events".to_string()]);
    }

    #[test]
    fn ignores_a_keyword_inside_an_identifier() {
        let existing = index(&[("analytics", "events")]);
        let by_name = HashMap::new();
        // `fromUnixTime` must not be read as a FROM clause.
        let found = references(
            "SELECT fromUnixTime(ts) FROM events",
            "analytics",
            &by_name,
            &existing,
        );
        assert_eq!(found, vec!["analytics.events".to_string()]);
    }

    #[test]
    fn ignores_a_from_inside_a_string() {
        let existing = index(&[("analytics", "events"), ("analytics", "fake")]);
        let by_name = HashMap::new();
        let found = references(
            "SELECT 'FROM fake' AS x FROM events",
            "analytics",
            &by_name,
            &existing,
        );
        assert_eq!(found, vec!["analytics.events".to_string()]);
    }

    #[test]
    fn unknown_names_do_not_become_edges() {
        let existing = index(&[("analytics", "events")]);
        let (by_name, _) = empty_index();
        let found = references("SELECT * FROM nowhere", "analytics", &by_name, &existing);
        assert!(found.is_empty());
    }
}
