//! Backups, as the server records them.
//!
//! `system.backups` is a log of what this server has been asked to back up or
//! restore, with what came of it. It is *not* a catalogue of what exists: it is
//! per-process and it does not survive a restart, so a backup taken last week by
//! a server that has since been restarted is on the disk and not in this table.
//! Which is the first thing this module has to be honest about — a screen that
//! presents this as "your backups" would have somebody conclude their backups had
//! vanished.

use serde::{Deserialize, Serialize};

use super::{Client, QueryOptions};
use crate::error::Result;

/// One backup or restore this server has run since it started.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRun {
    pub id: String,
    /// The destination as ClickHouse spells it: `Disk('backups', 'name.zip')`.
    pub name: String,
    /// `CREATING_BACKUP`, `BACKUP_CREATED`, `BACKUP_FAILED`, `RESTORING`,
    /// `RESTORED`, `RESTORE_FAILED` — the server's own word.
    pub status: String,
    pub error: String,
    pub started_at: String,
    /// Empty while it is still running.
    pub finished_at: String,
    pub files: u64,
    pub total_size: u64,
    pub compressed_size: u64,
    /// The statement's own id. Where Flint submitted it as a job, this carries
    /// the job's prefix, so a row here can be traced back to who asked.
    pub query_id: String,
    /// The object this backup was of.
    ///
    /// `system.backups` records the destination and not the source — the file,
    /// not the table — so this is only knowable for a backup Flint took, by
    /// following the `query_id` to its own job row. Empty otherwise, and the UI
    /// says so rather than offering a restore it cannot aim.
    #[serde(default)]
    pub target: String,
    /// Whether that object is there now. Restoring is offered into an absence
    /// and not over something, so this decides whether the control appears at
    /// all.
    #[serde(default)]
    pub target_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupReport {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub runs: Vec<BackupRun>,
    /// The disk Flint is configured to write to, or empty where none is. The UI
    /// needs it to say why the button is missing rather than just missing it.
    pub disk: String,
    /// Whether the configured destination is object storage.
    ///
    /// It decides the archive format, which is the one thing about an S3
    /// destination that Flint has to know: `zip` is refused outright on such a
    /// disk — "because it is backed by object storage, which does not support
    /// seeking efficiently" — and `.tar`, `.tar.gz` and `.tzst` all work. So the
    /// suggested name follows the disk rather than being always `.zip`.
    ///
    /// Everything *else* about S3 needs no code at all: a named disk keeps the
    /// credentials in the server's configuration, where `BACKUP … TO S3(url,
    /// key, secret)` would put them in a statement that both `query_log` and
    /// Flint's own job table record.
    pub object_storage: bool,
    /// Whether this list survives a restart.
    ///
    /// `system.backup_log` does and `system.backups` does not, and the page's own
    /// framing depends on which it read: "since this server started" is true of
    /// one and a needless disclaimer on the other.
    pub persistent: bool,
}

/// Whether the configured backup disk is object storage.
///
/// `system.disks.type` answers `ObjectStorage` for one, with
/// `object_storage_type` naming which — `S3`, `Azure`, and so on. Read rather
/// than inferred from the disk's name, which says nothing.
pub async fn disk_is_object_storage(ch: &Client, disk: &str) -> Result<bool> {
    if disk.is_empty() {
        return Ok(false);
    }
    #[derive(Deserialize)]
    struct Row {
        kind: String,
    }
    let row: Option<Row> = ch
        .row_with(
            "SELECT toString(type) AS kind FROM system.disks WHERE name = {d:String}",
            QueryOptions {
                params: vec![("d".into(), disk.to_string())],
                quote_64bit_integers: false,
                introspection: true,
                ..Default::default()
            },
        )
        .await?;
    Ok(row
        .map(|r| r.kind.eq_ignore_ascii_case("objectstorage"))
        .unwrap_or(false))
}

/// Whether the persistent log is there.
///
/// `system.backup_log` outlives a restart where `system.backups` does not, which
/// is the difference between a record of what this process did and a record of
/// what this *server* did. Measured: 24 rows going back two days, across a
/// container restart that emptied `system.backups` completely.
///
/// It is a `*_log` table, so it can be switched off, and then the in-memory one
/// is all there is — which the report says rather than quietly narrowing what
/// the page means.
async fn has_log(ch: &Client) -> Result<bool> {
    Ok(matches!(
        ch.reach("backup_log").await?,
        super::Reach::Readable
    ))
}

/// What this server has backed up or restored.
pub async fn runs(ch: &Client, disk: &str, limit: u64) -> Result<BackupReport> {
    let object_storage = disk_is_object_storage(ch, disk).await.unwrap_or(false);
    if has_log(ch).await? {
        return from_log(ch, disk, limit, object_storage).await;
    }
    match ch.reach("backups").await? {
        super::Reach::Readable => {}
        super::Reach::Denied => {
            return Ok(BackupReport {
                available: false,
                reason: Some("this user is not granted SELECT on system.backups".into()),
                runs: Vec::new(),
                disk: disk.to_string(),
                object_storage: false,
                persistent: false,
            })
        }
        _ => {
            return Ok(BackupReport {
                available: false,
                reason: Some("this ClickHouse has no system.backups".into()),
                runs: Vec::new(),
                disk: disk.to_string(),
                object_storage: false,
                persistent: false,
            })
        }
    }

    let sql = format!(
        "SELECT toString(id)                                  AS id, \
                name                                          AS name, \
                toString(status)                              AS status, \
                error                                         AS error, \
                toString(start_time)                          AS started_at, \
                if(end_time > start_time, toString(end_time), '') AS finished_at, \
                toUInt64(num_files)                           AS files, \
                toUInt64(total_size)                          AS total_size, \
                toUInt64(compressed_size)                     AS compressed_size, \
                toString(query_id)                            AS query_id \
         FROM system.backups \
         ORDER BY start_time DESC \
         LIMIT {}",
        limit.clamp(1, 200)
    );
    let runs: Vec<BackupRun> = ch.rows_with(&sql, QueryOptions::internal()).await?;
    Ok(BackupReport {
        available: true,
        reason: None,
        runs,
        disk: disk.to_string(),
        object_storage,
        persistent: false,
    })
}

/// The same list, from the log that survives a restart.
///
/// `backup_log` is an event log with a row per state change — `CREATING_BACKUP`
/// then `BACKUP_CREATED`, `RESTORING` then `RESTORED` — so the outcome is the
/// last row for each id, and a naive read shows every backup twice with the
/// first row saying it is still running.
///
/// The ordering is by `event_time_microseconds` and not `event_time`, which is
/// the bug this had first: both rows of a fast backup land in the *same second*,
/// so `argMax` over a `DateTime` picks between them arbitrarily and the page
/// reported every finished backup as still creating. The microsecond column
/// exists for exactly this.
async fn from_log(
    ch: &Client,
    disk: &str,
    limit: u64,
    object_storage: bool,
) -> Result<BackupReport> {
    let sql = format!(
        "SELECT id                                            AS id, \
                argMax(name, event_time_microseconds)         AS name, \
                toString(argMax(status, event_time_microseconds)) AS status, \
                argMax(error, event_time_microseconds)        AS error, \
                toString(min(start_time))                     AS started_at, \
                if(max(end_time) > min(start_time), toString(max(end_time)), '') AS finished_at, \
                toUInt64(max(num_files))                      AS files, \
                toUInt64(max(total_size))                     AS total_size, \
                toUInt64(max(compressed_size))                AS compressed_size, \
                argMax(query_id, event_time_microseconds)     AS query_id \
         FROM system.backup_log \
         GROUP BY id \
         ORDER BY started_at DESC \
         LIMIT {}",
        limit.clamp(1, 200)
    );
    let runs: Vec<BackupRun> = ch.rows_with(&sql, QueryOptions::internal()).await?;
    Ok(BackupReport {
        available: true,
        reason: None,
        runs,
        disk: disk.to_string(),
        object_storage,
        persistent: true,
    })
}

/// What can be asked of a backup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupAction {
    /// Write one. Reads data and writes a file; destroys nothing.
    Take,
    /// Read one back. Writes data, and is refused here unless the target is
    /// absent — see the route.
    Restore,
}

impl BackupAction {
    pub fn kind(self) -> &'static str {
        match self {
            BackupAction::Take => "backup",
            BackupAction::Restore => "restore",
        }
    }
}

/// A file name Flint is willing to put inside a quoted literal.
///
/// `BACKUP … TO Disk(name, file)` takes no bindings, so the shape is checked
/// rather than escaped. A backup file is named by whoever asks, so this is the
/// one place on this path where the input is genuinely free text — and it is
/// held to letters, digits and the three punctuation marks a file name needs.
pub fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Whether this archive format works where it is going.
///
/// Measured against a real MinIO: `zip` is refused on an object-storage disk —
/// `Code: 36 … because it is backed by object storage, which does not support
/// seeking efficiently (zip requires seeking)` — and `.tar`, `.tar.gz` and
/// `.tzst` all succeed. On a local disk `.zip` is the ordinary choice.
///
/// A name with no extension at all is accepted by both and means something
/// different: it writes a *directory* of many objects rather than one archive.
/// That is a legitimate thing to want, so it is allowed and not corrected.
pub fn format_refusal(file: &str, object_storage: bool) -> Option<String> {
    let lower = file.to_ascii_lowercase();
    if object_storage && lower.ends_with(".zip") {
        return Some(
            "a zip cannot be written to object storage — the server refuses it, because zip \
             requires seeking and S3 does not support that efficiently. Use .tar.gz, .tar or \
             .tzst, or no extension at all for a directory of objects."
                .to_string(),
        );
    }
    None
}

/// The statement one backup action sends.
///
/// `TABLE` where a table is named and `DATABASE` where it is not, with the name
/// quoted the way every other statement Flint builds quotes it. The destination
/// is `Disk(disk, file)`, with the disk coming from the manifest and the file
/// from the caller.
///
/// A whole database is one statement rather than a loop over its tables, which
/// matters for what "done" means: `RESTORE DATABASE` puts the tables *and their
/// definitions* back, so a database dropped entirely comes back whole — verified
/// by dropping one with two tables and reading both back with all their rows.
/// Restoring table by table would need the tables to exist first.
pub fn backup_statement(
    action: BackupAction,
    database: &str,
    table: &str,
    disk: &str,
    file: &str,
) -> String {
    let ident = |s: &str| format!("`{}`", s.replace('`', "``"));
    let at = format!("Disk('{disk}', '{file}')");
    let (what, target) = if table.is_empty() {
        ("DATABASE", ident(database))
    } else {
        ("TABLE", format!("{}.{}", ident(database), ident(table)))
    };
    match action {
        BackupAction::Take => format!("BACKUP {what} {target} TO {at}"),
        BackupAction::Restore => format!("RESTORE {what} {target} FROM {at}"),
    }
}

/// Fill in what each backup was *of*, and whether it is still there.
///
/// `system.backups` knows the destination and not the source. Flint's own job
/// rows know both, so the two are joined on the `query_id` the job runner sets —
/// which means this works for backups Flint took and for nothing else. That is
/// the honest limit: a backup somebody took in a terminal has a file and no
/// recoverable target, and offering to restore it would mean guessing which table
/// it held.
pub fn attach_targets(runs: &mut [BackupRun], by_job: &std::collections::HashMap<String, String>) {
    for run in runs.iter_mut() {
        if let Some(id) = run.query_id.strip_prefix("flint-job-") {
            if let Some(target) = by_job.get(id) {
                run.target = target.clone();
            }
        }
    }
}

/// Mark the ones whose object is gone.
pub fn mark_existing(runs: &mut [BackupRun], existing: &std::collections::HashSet<String>) {
    for run in runs.iter_mut() {
        run.target_exists = !run.target.is_empty() && existing.contains(&run.target);
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    #[test]
    fn a_zip_is_refused_on_object_storage_and_nowhere_else() {
        // Measured against a real MinIO: the server answers code 36 with the
        // reason, and `.tar.gz` succeeds on the same disk.
        let says = format_refusal("nightly.zip", true).expect("refused");
        assert!(says.contains("requires seeking"));
        assert!(says.contains(".tar.gz"));
        assert!(format_refusal("nightly.zip", false).is_none());
        assert!(format_refusal("nightly.tar.gz", true).is_none());
        assert!(format_refusal("nightly.TAR.GZ", true).is_none());
        // Case in the extension does not change what the server will do.
        assert!(format_refusal("nightly.ZIP", true).is_some());
    }

    #[test]
    fn no_extension_is_a_directory_and_is_left_alone() {
        // It writes many objects rather than one archive, which is a legitimate
        // thing to want and not a mistake to correct.
        assert!(format_refusal("nightly", true).is_none());
        assert!(format_refusal("nightly", false).is_none());
    }

    #[test]
    fn no_table_means_the_whole_database() {
        assert_eq!(
            backup_statement(BackupAction::Take, "scratch", "", "backups", "whole.zip"),
            "BACKUP DATABASE `scratch` TO Disk('backups', 'whole.zip')"
        );
        assert_eq!(
            backup_statement(BackupAction::Restore, "scratch", "", "backups", "whole.zip"),
            "RESTORE DATABASE `scratch` FROM Disk('backups', 'whole.zip')"
        );
    }

    #[test]
    fn a_named_table_is_still_a_table() {
        assert_eq!(
            backup_statement(
                BackupAction::Take,
                "analytics",
                "events",
                "backups",
                "e.zip"
            ),
            "BACKUP TABLE `analytics`.`events` TO Disk('backups', 'e.zip')"
        );
    }

    #[test]
    fn a_database_name_is_quoted_like_any_other() {
        assert_eq!(
            backup_statement(BackupAction::Take, "we`ird", "", "backups", "w.zip"),
            "BACKUP DATABASE `we``ird` TO Disk('backups', 'w.zip')"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(over: fn(&mut BackupRun)) -> BackupRun {
        let mut r = BackupRun {
            id: "1".into(),
            name: "Disk('backups', 'e.zip')".into(),
            status: "BACKUP_CREATED".into(),
            error: String::new(),
            started_at: String::new(),
            finished_at: String::new(),
            files: 1,
            total_size: 1,
            compressed_size: 1,
            query_id: "flint-job-abc".into(),
            target: "analytics.events".into(),
            target_exists: false,
        };
        over(&mut r);
        r
    }

    #[test]
    fn a_target_is_only_knowable_for_a_backup_flint_took() {
        let mut runs = vec![
            run(|r| r.query_id = "flint-job-abc".into()),
            run(|r| {
                r.query_id = "8cfee2c2-6110-4049".into();
                r.target = String::new();
            }),
        ];
        for r in runs.iter_mut() {
            r.target = String::new();
        }
        let mut by_job = std::collections::HashMap::new();
        by_job.insert("abc".to_string(), "analytics.events".to_string());
        attach_targets(&mut runs, &by_job);
        assert_eq!(runs[0].target, "analytics.events");
        // Somebody's `clickhouse-client` backup has a file and no recoverable
        // target; offering to restore it would mean guessing which table it held.
        assert_eq!(runs[1].target, "");
    }

    #[test]
    fn a_file_name_is_a_file_name() {
        assert!(valid_file_name("events-2026-08-25.zip"));
        assert!(valid_file_name("nightly.zip"));
        assert!(!valid_file_name(""));
        // The ones that matter: the name goes inside a quoted literal, and onto a
        // filesystem.
        assert!(!valid_file_name("events'.zip"));
        assert!(!valid_file_name("../etc/passwd"));
        assert!(!valid_file_name("a/b.zip"));
        assert!(!valid_file_name(".hidden"));
        assert!(!valid_file_name("with space.zip"));
    }

    #[test]
    fn the_two_statements_differ_only_in_direction() {
        assert_eq!(
            backup_statement(
                BackupAction::Take,
                "analytics",
                "events",
                "backups",
                "e.zip"
            ),
            "BACKUP TABLE `analytics`.`events` TO Disk('backups', 'e.zip')"
        );
        assert_eq!(
            backup_statement(
                BackupAction::Restore,
                "analytics",
                "events",
                "backups",
                "e.zip"
            ),
            "RESTORE TABLE `analytics`.`events` FROM Disk('backups', 'e.zip')"
        );
    }

    #[test]
    fn a_back_quote_in_a_name_is_doubled() {
        let sql = backup_statement(BackupAction::Take, "we`ird", "t", "backups", "f.zip");
        assert!(sql.starts_with("BACKUP TABLE `we``ird`.`t` TO"), "{sql}");
    }
}
