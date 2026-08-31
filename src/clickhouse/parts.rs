//! Parts that are on the disk and not in the table.
//!
//! `detached/` is where a MergeTree puts a part it is not using. Two very
//! different things end up there and `system.detached_parts` tells them apart in
//! one column:
//!
//! - **You detached it.** `ALTER TABLE … DETACH PARTITION` is how a partition is
//!   taken out to be moved, inspected or backed up. `reason` is empty, the data
//!   is fine, and reattaching it is the obvious next step.
//! - **The server quarantined it.** A part that failed its checksums, arrived
//!   unexpectedly, or was covered by a broken one gets moved aside with a prefix
//!   and a `reason`. Reattaching that without reading the reason is how a broken
//!   part gets put back into a table.
//!
//! Which is the whole argument for this screen existing: the two look identical
//! in a directory listing, they occupy disk either way, and nothing in ClickHouse
//! will ever clean them up on its own. A part detached in March is still there in
//! December, and the only reason anybody finds out is that a disk fills.

use serde::{Deserialize, Serialize};

use super::Client;
use crate::error::Result;

/// One part sitting in `detached/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetachedPart {
    pub database: String,
    pub table: String,
    pub qualified: String,
    /// The partition it came out of. Nullable on the server for parts that
    /// arrived without one; empty here rather than absent, because a partition
    /// nobody can name is still a part somebody has to decide about.
    pub partition_id: String,
    /// The directory name, which is also what `ATTACH PART` takes.
    pub name: String,
    pub bytes: u64,
    /// When it was last written, which for a detached part is when it was
    /// detached — the closest thing to an age this table has.
    pub detached_at: String,
    pub disk: String,
    /// Empty when a person detached it. Otherwise the server's own word for why
    /// it moved the part aside: `broken`, `unexpected`, `ignored`, and so on.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetachedReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub parts: Vec<DetachedPart>,
    /// Every detached part, not only the ones listed — this is disk nobody is
    /// using, and a total cut off at a page would understate it.
    pub total: u64,
    pub total_bytes: u64,
    /// How many the server moved aside itself. The number that decides whether
    /// this screen is housekeeping or a symptom.
    pub quarantined: u64,
}

/// Everything in `detached/`, largest first.
///
/// By size rather than by age: the reason to look at this screen is almost always
/// that a disk is filling, and the part that matters is the big one.
pub async fn detached(ch: &Client, limit: u64) -> Result<DetachedReport> {
    if let Some(why) = blocked(ch).await? {
        return Ok(DetachedReport {
            available: false,
            reason: Some(why),
            parts: Vec::new(),
            total: 0,
            total_bytes: 0,
            quarantined: 0,
        });
    }

    let sql = format!(
        "SELECT database                                  AS database, \
                table                                     AS table, \
                concat(database, '.', table)              AS qualified, \
                coalesce(partition_id, '')                AS partition_id, \
                name                                      AS name, \
                bytes_on_disk                             AS bytes, \
                toString(modification_time)               AS detached_at, \
                disk                                      AS disk, \
                coalesce(reason, '')                      AS reason \
         FROM system.detached_parts \
         ORDER BY bytes_on_disk DESC \
         LIMIT {}",
        limit.clamp(1, 500)
    );
    let parts: Vec<DetachedPart> = ch.rows(&sql).await?;

    #[derive(Deserialize)]
    struct Totals {
        total: u64,
        total_bytes: u64,
        quarantined: u64,
    }
    let totals: Option<Totals> = ch
        .row(
            "SELECT toUInt64(count())                                   AS total, \
                    toUInt64(sum(bytes_on_disk))                        AS total_bytes, \
                    toUInt64(countIf(coalesce(reason, '') != ''))        AS quarantined \
             FROM system.detached_parts",
        )
        .await?;

    Ok(DetachedReport {
        available: true,
        reason: None,
        parts,
        total: totals.as_ref().map(|t| t.total).unwrap_or(0),
        total_bytes: totals.as_ref().map(|t| t.total_bytes).unwrap_or(0),
        quarantined: totals.map(|t| t.quarantined).unwrap_or(0),
    })
}

async fn blocked(ch: &Client) -> Result<Option<String>> {
    Ok(match ch.reach("detached_parts").await? {
        super::Reach::Readable => None,
        super::Reach::Denied => {
            Some("this user is not granted SELECT on system.detached_parts".to_string())
        }
        super::Reach::Absent | super::Reach::Unconfigured => {
            Some("this ClickHouse has no system.detached_parts".to_string())
        }
    })
}

/// What can be done with a detached part.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PartAction {
    /// Put it back in the table.
    Attach,
    /// Delete it from the disk, for good.
    Drop,
}

impl PartAction {
    pub fn kind(self) -> &'static str {
        match self {
            PartAction::Attach => "attach-part",
            PartAction::Drop => "drop-detached-part",
        }
    }

    pub fn label(self, qualified: &str, name: &str) -> String {
        match self {
            PartAction::Attach => format!("Attach {name} to {qualified}"),
            PartAction::Drop => format!("Delete detached {name} from {qualified}"),
        }
    }
}

/// The statement one part action sends.
///
/// `DROP DETACHED PART` carries its own setting, and it carries it in the text
/// rather than in the request: the statement is what the job records, and a
/// permanent deletion should read in the log exactly as it was sent — including
/// the flag that ClickHouse requires before it will do it at all.
pub fn part_statement(action: PartAction, database: &str, table: &str, part: &str) -> String {
    let ident = |s: &str| format!("`{}`", s.replace('`', "``"));
    match action {
        PartAction::Attach => format!(
            "ALTER TABLE {}.{} ATTACH PART '{part}'",
            ident(database),
            ident(table)
        ),
        PartAction::Drop => format!(
            "ALTER TABLE {}.{} DROP DETACHED PART '{part}' SETTINGS allow_drop_detached = 1",
            ident(database),
            ident(table)
        ),
    }
}

/// A part name Flint is willing to put inside a quoted literal.
///
/// The name goes into the statement as a string, not as a parameter — `ALTER …
/// ATTACH PART` takes no bindings — so the shape is checked here instead. Real
/// names are block numbers, underscores and a prefix the server chose;
/// everything else is refused rather than escaped, because there is no legitimate
/// detached part with a quote in its name and guessing which escape ClickHouse
/// wants is how this kind of thing goes wrong.
pub fn valid_part_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// What can be done with a whole partition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PartitionAction {
    /// Take it out of the table. The data stays on the disk in `detached/`, which
    /// is where the detached-parts screen picks it up.
    Detach,
    /// Hard-link a copy into `shadow/`. Costs no space until the originals are
    /// merged away, and is the thing to do *before* dropping something.
    ///
    /// One-way on most servers, which is worth knowing before offering it:
    /// `SYSTEM UNFREEZE` is gated behind the `enable_system_unfreeze` *server*
    /// setting and is off by default, so a frozen copy usually cannot be removed
    /// by any statement — only by deleting the directory on the machine. Flint
    /// says so rather than leaving it to be discovered.
    Freeze,
    /// Delete it. Nothing brings it back.
    Drop,
    /// Move it to another volume of the table's storage policy.
    ///
    /// Left out of the first version of this enum with a stated reason — "this
    /// server has one disk, and a control for moving data between volumes that
    /// has never moved any is not a control worth shipping". The development
    /// fixture now has two volumes and the move has been watched to work, so the
    /// reason no longer holds.
    ///
    /// What the work found is that the move can be undone by the server within
    /// seconds and without anybody asking: a policy whose `move_factor` exceeds
    /// its hot volume's free-space ratio is being drained continuously in the
    /// background. Measured at 0.197 against 0.2, a partition moved back onto
    /// the hot volume by hand returned to cold in three seconds. The control
    /// says so where the storage page has found it to be true.
    MoveToVolume,
    /// Move it to one named disk instead of a volume.
    MoveToDisk,
}

impl PartitionAction {
    pub fn kind(self) -> &'static str {
        match self {
            PartitionAction::Detach => "detach-partition",
            PartitionAction::Freeze => "freeze-partition",
            PartitionAction::Drop => "drop-partition",
            PartitionAction::MoveToVolume | PartitionAction::MoveToDisk => "move-partition",
        }
    }

    /// Whether this action needs somewhere to move to.
    pub fn needs_destination(self) -> bool {
        matches!(
            self,
            PartitionAction::MoveToVolume | PartitionAction::MoveToDisk
        )
    }

    pub fn label(self, qualified: &str, partition: &str) -> String {
        let what = match self {
            PartitionAction::Detach => "Detach",
            PartitionAction::Freeze => "Freeze",
            PartitionAction::Drop => "Drop",
            PartitionAction::MoveToVolume | PartitionAction::MoveToDisk => "Move",
        };
        format!("{what} {partition} of {qualified}")
    }
}

/// The statement one partition action sends.
///
/// `PARTITION ID` rather than a partition expression, always. The expression form
/// takes whatever the partition key evaluates to and has to be quoted and typed
/// correctly for that key; the id is the opaque string ClickHouse itself reports
/// in `system.parts.partition_id`, and it is the same string for a tuple key, a
/// date key or no key at all — where it is `all`, which is worth knowing before
/// pressing anything.
///
/// A freeze is *named*, and that is not cosmetic: an unnamed `FREEZE` gets a
/// sequential integer in `shadow/`, and an operator looking for it a week later
/// has no way to tell which number was theirs. The name goes into the statement,
/// so the job's own record of what it ran contains it.
pub fn partition_statement(
    action: PartitionAction,
    database: &str,
    table: &str,
    partition_id: &str,
    freeze_name: &str,
    destination: &str,
) -> String {
    let ident = |s: &str| format!("`{}`", s.replace('`', "``"));
    let target = format!("{}.{}", ident(database), ident(table));
    match action {
        PartitionAction::Detach => {
            format!("ALTER TABLE {target} DETACH PARTITION ID '{partition_id}'")
        }
        PartitionAction::Drop => {
            format!("ALTER TABLE {target} DROP PARTITION ID '{partition_id}'")
        }
        PartitionAction::Freeze => format!(
            "ALTER TABLE {target} FREEZE PARTITION ID '{partition_id}' WITH NAME '{freeze_name}'"
        ),
        PartitionAction::MoveToVolume => format!(
            "ALTER TABLE {target} MOVE PARTITION ID '{partition_id}' TO VOLUME '{destination}'"
        ),
        PartitionAction::MoveToDisk => format!(
            "ALTER TABLE {target} MOVE PARTITION ID '{partition_id}' TO DISK '{destination}'"
        ),
    }
}

/// A volume or disk name Flint will put inside a quoted literal.
///
/// The same reasoning as a partition id: the destination goes into a string
/// literal that ClickHouse parses, and there is no parameter binding for it, so
/// the characters are restricted to the ones a storage name is actually made of.
pub fn valid_storage_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// A partition id Flint is willing to put inside a quoted literal.
///
/// Same reasoning as a part name: `ALTER … PARTITION ID` takes no bindings, so
/// the shape is checked rather than escaped. ClickHouse's ids are hex digests,
/// date strings, or the literal `all` for a table with no partition key.
pub fn valid_partition_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 255
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// A name for a frozen copy that an operator can find again.
///
/// Carries the partition it came from and a short random tail, so two freezes of
/// the same partition an hour apart are distinguishable in `shadow/` — and so
/// nothing has to be unique across a cluster.
pub fn freeze_name(partition_id: &str) -> String {
    let tail = uuid::Uuid::new_v4().simple().to_string();
    format!("flint_{partition_id}_{}", &tail[..8])
}

/// One object, as the Schema section lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Object {
    pub database: String,
    pub name: String,
    pub qualified: String,
    pub engine: String,
    /// `table`, `view`, `materialized view`, `dictionary`.
    pub kind: String,
    /// Null where the object stores nothing — a view has no rows, and printing
    /// zero would answer a question nobody asked.
    pub rows: Option<u64>,
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub objects: Vec<Object>,
    /// Everything the user can see, not only what is listed.
    pub total: u64,
}

/// Every object on the server this user can see, largest first.
///
/// Server-wide, because Infrastructure has no object rail: the rail is Data's
/// navigator and does not follow you across. Largest first, because the reason to
/// open a list of things you can drop is usually that something is too big.
///
/// ClickHouse's own databases are left out. Nothing here should ever be pointed
/// at `system`, and listing two hundred of its tables beside a user's twelve
/// would bury them.
pub async fn objects(ch: &Client, limit: u64) -> Result<SchemaReport> {
    match ch.reach("tables").await? {
        super::Reach::Readable => {}
        _ => {
            return Ok(SchemaReport {
                available: false,
                reason: Some("this user is not granted SELECT on system.tables".into()),
                objects: Vec::new(),
                total: 0,
            })
        }
    }

    let sql = format!(
        "SELECT database                                  AS database, \
                name                                      AS name, \
                concat(database, '.', name)               AS qualified, \
                engine                                    AS engine, \
                multiIf(engine = 'MaterializedView', 'materialized view', \
                        engine = 'View', 'view', \
                        engine = 'Dictionary', 'dictionary', \
                        'table')                          AS kind, \
                total_rows                                AS rows, \
                total_bytes                               AS bytes \
         FROM system.tables \
         WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') \
           AND NOT is_temporary \
         ORDER BY coalesce(total_bytes, 0) DESC, database, name \
         LIMIT {}",
        limit.clamp(1, 2000)
    );
    let objects: Vec<Object> = ch.rows(&sql).await?;

    #[derive(Deserialize)]
    struct Count {
        n: u64,
    }
    let total: Option<Count> = ch
        .row(
            "SELECT toUInt64(count()) AS n FROM system.tables \
             WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') \
               AND NOT is_temporary",
        )
        .await?;

    Ok(SchemaReport {
        available: true,
        reason: None,
        objects,
        total: total.map(|c| c.n).unwrap_or(0),
    })
}

/// What can be done to a whole object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectAction {
    /// Empty it, keeping the definition. Rows gone.
    Truncate,
    /// Remove it entirely. Rows and definition gone.
    Drop,
}

impl ObjectAction {
    pub fn kind(self) -> &'static str {
        match self {
            ObjectAction::Truncate => "truncate-table",
            ObjectAction::Drop => "drop-table",
        }
    }

    pub fn label(self, qualified: &str, kind: &str) -> String {
        match self {
            ObjectAction::Truncate => format!("Truncate {qualified}"),
            ObjectAction::Drop => format!("Drop {kind} {qualified}"),
        }
    }
}

/// The statement one object action sends.
///
/// `DROP TABLE` works for a view too — ClickHouse accepts it for anything in
/// `system.tables` — but the *word* matters in the confirmation and the log, so
/// the kind is carried through to the label rather than flattened to "table".
///
/// No `IF EXISTS`. The route has already checked that the object is there, and a
/// statement that succeeds against nothing would let a job report `done` about
/// work that never happened — which is the one thing a record of destructive
/// operations must not do.
pub fn object_statement(action: ObjectAction, database: &str, table: &str) -> String {
    let ident = |s: &str| format!("`{}`", s.replace('`', "``"));
    let target = format!("{}.{}", ident(database), ident(table));
    match action {
        ObjectAction::Truncate => format!("TRUNCATE TABLE {target}"),
        ObjectAction::Drop => format!("DROP TABLE {target}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partition_id_is_what_clickhouse_reports_and_nothing_else() {
        assert!(valid_partition_id("202605"));
        // A table with no partition key: every part is in `all`, which is worth
        // knowing before pressing Drop.
        assert!(valid_partition_id("all"));
        // A tuple key gives a hex digest.
        assert!(valid_partition_id("a1b2c3d4e5f6"));
        assert!(!valid_partition_id(""));
        assert!(!valid_partition_id("202605'"));
        assert!(!valid_partition_id("tuple()"));
        assert!(!valid_partition_id("202605 OR 1=1"));
    }

    #[test]
    fn a_partition_action_uses_the_id_form_and_names_its_freeze() {
        assert_eq!(
            partition_statement(
                PartitionAction::Detach,
                "analytics",
                "events",
                "202605",
                "",
                ""
            ),
            "ALTER TABLE `analytics`.`events` DETACH PARTITION ID '202605'"
        );
        assert_eq!(
            partition_statement(PartitionAction::Drop, "analytics", "events", "all", "", ""),
            "ALTER TABLE `analytics`.`events` DROP PARTITION ID 'all'"
        );
        let frozen = partition_statement(
            PartitionAction::Freeze,
            "analytics",
            "events",
            "202605",
            "flint_202605_ab12cd34",
            "",
        );
        // Named, because an unnamed freeze gets a sequential integer nobody can
        // match to the thing they froze.
        assert!(
            frozen.ends_with("WITH NAME 'flint_202605_ab12cd34'"),
            "{frozen}"
        );
    }

    #[test]
    fn a_freeze_name_carries_its_partition_and_is_not_reused() {
        let a = freeze_name("202605");
        let b = freeze_name("202605");
        assert!(a.starts_with("flint_202605_"), "{a}");
        assert_ne!(a, b, "two freezes of one partition must be distinguishable");
        assert!(valid_partition_id(a.trim_start_matches("flint_")), "{a}");
    }

    #[test]
    fn an_object_action_says_what_it_does_and_does_not_hedge() {
        assert_eq!(
            object_statement(ObjectAction::Drop, "analytics", "events"),
            "DROP TABLE `analytics`.`events`"
        );
        assert_eq!(
            object_statement(ObjectAction::Truncate, "analytics", "events"),
            "TRUNCATE TABLE `analytics`.`events`"
        );
        // No `IF EXISTS`: a statement that succeeds against nothing would let a
        // job report `done` about work that never happened.
        for action in [ObjectAction::Drop, ObjectAction::Truncate] {
            assert!(
                !object_statement(action, "a", "b").contains("IF EXISTS"),
                "{action:?} must not hedge"
            );
        }
    }

    #[test]
    fn dropping_a_view_still_says_view_in_its_label() {
        // ClickHouse takes `DROP TABLE` for a view, but the confirmation and the
        // log are read by people.
        assert_eq!(
            ObjectAction::Drop.label("analytics.errors", "view"),
            "Drop view analytics.errors"
        );
    }

    #[test]
    fn a_part_name_is_block_numbers_and_nothing_clever() {
        assert!(valid_part_name("202605_4_4_12"));
        // The prefixes the server adds when it quarantines something.
        assert!(valid_part_name("broken_202608_1_1_0"));
        assert!(valid_part_name("unexpected_all_1_1_0"));
        assert!(!valid_part_name(""));
        assert!(!valid_part_name(&"x".repeat(256)));
        // The ones that matter: the name is interpolated into a quoted literal.
        assert!(!valid_part_name("202605_1_1_0'"));
        assert!(!valid_part_name("202605\\_1"));
        assert!(!valid_part_name("part with spaces"));
        assert!(!valid_part_name("202605\n1"));
    }

    #[test]
    fn attaching_and_dropping_are_spelled_differently_on_purpose() {
        assert_eq!(
            part_statement(PartAction::Attach, "analytics", "events", "202605_4_4_12"),
            "ALTER TABLE `analytics`.`events` ATTACH PART '202605_4_4_12'"
        );
        // The setting is in the text, so the job's own record of what it ran
        // includes the flag ClickHouse demands before deleting anything.
        let drop = part_statement(PartAction::Drop, "analytics", "events", "202605_4_4_12");
        assert!(
            drop.contains("DROP DETACHED PART '202605_4_4_12'"),
            "{drop}"
        );
        assert!(drop.contains("allow_drop_detached = 1"), "{drop}");
    }

    #[test]
    fn a_back_quote_in_a_table_name_is_doubled() {
        let sql = part_statement(PartAction::Attach, "we`ird", "ta`ble", "all_1_1_0");
        assert!(
            sql.starts_with("ALTER TABLE `we``ird`.`ta``ble` ATTACH PART"),
            "{sql}"
        );
    }
}
