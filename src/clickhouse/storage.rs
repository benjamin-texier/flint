//! Where a table's data is allowed to live, and where it actually is.
//!
//! ClickHouse's storage policies are the tiering mechanism: a policy holds
//! volumes in priority order, a volume holds disks, and a part is written to the
//! first volume that will take it. Three things about that are invisible in the
//! configuration file and are the reason this module exists.
//!
//! **`move_factor` is about free space, and it fires on its own.** It is not "how
//! much to move"; it is the free-space ratio below which the server starts
//! draining a volume downward, continuously, in the background. On a machine
//! whose disk is 80% full a `move_factor` of 0.2 is already satisfied — measured
//! here at 0.197 against 0.2 — so every part written to the hot volume leaves it
//! within seconds. A partition moved there by hand came back in three. A page
//! that offered "move to the hot volume" without saying that would be offering a
//! button whose effect outlives the click by less than a breath.
//!
//! **A disk in no policy can never hold a part.** `system.disks` lists disks the
//! server knows about, and the backup disk on a stock development server is one
//! nothing can be written to by any table. It looks like capacity and is not.
//!
//! **Volumes on the same filesystem are not tiers.** Two disks whose free and
//! total space match to the byte are almost certainly one filesystem, which
//! means a policy built to move cold data "off" the hot volume protects nothing
//! from filling up. That cannot be read from `system.disks` directly — there is
//! no filesystem id in it — so it is said as the inference it is.

use serde::{Deserialize, Serialize};

use super::{Client, Reach, Section};
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Disk {
    pub name: String,
    pub path: String,
    pub free: u64,
    pub total: u64,
    #[serde(rename = "type")]
    pub kind: String,
    /// The policies whose volumes include this disk. Empty means nothing can
    /// ever be written here — filled in after the read, because the answer is a
    /// join across the two tables and not a column of either.
    #[serde(default)]
    pub used_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Volume {
    pub policy: String,
    pub volume: String,
    /// Lower goes first. A part is written to the first volume that will take it.
    pub priority: u64,
    pub disks: Vec<String>,
    /// `JBOD` spreads parts across the disks; `SINGLE_DISK` does not.
    pub kind: String,
    /// A part bigger than this skips the volume entirely. Zero means no cap.
    pub max_part: u64,
    /// The free-space ratio below which the server drains this volume downward
    /// on its own. Zero means it never does.
    pub move_factor: f64,
    /// Whether that is happening **now**, computed from the disks' own free
    /// space. This is the field the page is for.
    #[serde(default)]
    pub draining: bool,
    /// The free-space ratio of the fullest disk in this volume, which is what
    /// `move_factor` is compared against.
    #[serde(default)]
    pub free_ratio: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageReport {
    pub disks: Section<Disk>,
    pub volumes: Section<Volume>,
    pub verdicts: Vec<String>,
}

pub async fn storage(ch: &Client) -> Result<StorageReport> {
    let blocked = match ch.reach("storage_policies").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.storage_policies".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.storage_policies".to_string())
        }
    };
    if let Some(reason) = blocked {
        return Ok(StorageReport {
            disks: Section::blocked(reason.clone()),
            volumes: Section::blocked(reason),
            verdicts: Vec::new(),
        });
    }

    let mut disks: Vec<Disk> = ch
        .rows(
            "SELECT name                  AS name, \
                    path                  AS path, \
                    free_space            AS free, \
                    total_space           AS total, \
                    type                  AS type \
             FROM system.disks ORDER BY name LIMIT 500",
        )
        .await?;

    let mut volumes: Vec<Volume> = ch
        .rows(
            "SELECT policy_name                    AS policy, \
                    volume_name                    AS volume, \
                    toUInt64(volume_priority)      AS priority, \
                    disks                          AS disks, \
                    toString(volume_type)          AS kind, \
                    max_data_part_size             AS max_part, \
                    move_factor                    AS move_factor \
             FROM system.storage_policies \
             ORDER BY policy_name, volume_priority LIMIT 1000",
        )
        .await?;

    attach(&mut disks, &mut volumes);
    Ok(StorageReport {
        verdicts: verdicts(&disks, &volumes),
        disks: Section::of(disks),
        volumes: Section::of(volumes),
    })
}

/// Join the two tables into the answers neither of them holds.
///
/// Which policies use a disk, and whether a volume is being drained right now.
/// Pure, so the arithmetic behind "the mover is running" can be tested without a
/// server that happens to be nearly full.
pub fn attach(disks: &mut [Disk], volumes: &mut [Volume]) {
    for disk in disks.iter_mut() {
        let mut using: Vec<String> = volumes
            .iter()
            .filter(|v| v.disks.iter().any(|d| d == &disk.name))
            .map(|v| v.policy.clone())
            .collect();
        using.sort();
        using.dedup();
        disk.used_by = using;
    }

    // Which volumes have a volume below them, worked out before the borrow: the
    // mover moves data *downward* through the priority order, so the lowest
    // volume of a policy has nowhere to send anything and is never drained
    // however full it is. Reading the output was what caught this — the page
    // announced that the cold volume was being drained, and the partition that
    // had arrived there in the experiment had sat still.
    let lowest: Vec<(String, u64)> = {
        let mut out: Vec<(String, u64)> = Vec::new();
        for v in volumes.iter() {
            match out.iter_mut().find(|(p, _)| p == &v.policy) {
                Some((_, prio)) => *prio = (*prio).max(v.priority),
                None => out.push((v.policy.clone(), v.priority)),
            }
        }
        out
    };

    for volume in volumes.iter_mut() {
        let has_somewhere_below = lowest
            .iter()
            .find(|(p, _)| p == &volume.policy)
            .map(|(_, prio)| volume.priority < *prio)
            .unwrap_or(false);
        // The fullest disk in the volume decides, because that is the one that
        // runs out first and the mover watches the volume as a whole.
        volume.free_ratio = volume
            .disks
            .iter()
            .filter_map(|name| disks.iter().find(|d| &d.name == name))
            .filter(|d| d.total > 0)
            .map(|d| d.free as f64 / d.total as f64)
            .fold(f64::INFINITY, f64::min);
        if !volume.free_ratio.is_finite() {
            volume.free_ratio = 0.0;
            volume.draining = false;
            continue;
        }
        volume.draining = volume.move_factor > 0.0
            && volume.free_ratio < volume.move_factor
            && has_somewhere_below;
    }
}

/// What is worth saying about this configuration.
pub fn verdicts(disks: &[Disk], volumes: &[Volume]) -> Vec<String> {
    let mut out = Vec::new();

    // The one that turns a button into a lie, so it comes first.
    for v in volumes.iter().filter(|v| v.draining) {
        out.push(format!(
            "The {} volume of policy {} is being drained now: {:.1}% of it is free and its \
             move factor is {:.1}%, so the server is moving parts off it in the background. \
             Anything moved onto it by hand will leave again within seconds.",
            v.volume,
            v.policy,
            v.free_ratio * 100.0,
            v.move_factor * 100.0
        ));
    }

    for d in disks.iter().filter(|d| d.used_by.is_empty()) {
        out.push(format!(
            "Disk {} belongs to no storage policy, so no table can put a part on it. It looks \
             like capacity and is not.",
            d.name
        ));
    }

    // Two disks matching to the byte are one filesystem, near enough. Said as
    // the inference it is, because `system.disks` carries no filesystem id.
    for v in volumes.iter().filter(|v| v.disks.len() > 1) {
        if same_filesystem(&v.disks, disks) {
            out.push(format!(
                "The disks of volume {} in policy {} report identical free and total space, \
                 which almost always means one filesystem. Spreading parts across them buys \
                 throughput and no protection from filling up.",
                v.volume, v.policy
            ));
        }
    }
    for policy in policies(volumes) {
        let across: Vec<&str> = volumes
            .iter()
            .filter(|v| v.policy == policy)
            .flat_map(|v| v.disks.iter().map(String::as_str))
            .collect();
        if across.len() > 1 && same_filesystem_names(&across, disks) {
            out.push(format!(
                "Policy {policy} moves data between volumes that report identical space, which \
                 almost always means one filesystem. A tier that does not change which disk can \
                 fill up is not a tier."
            ));
        }
    }

    // A volume nothing ordinary will land on. Worth knowing before wondering why
    // the hot tier is empty.
    for v in volumes
        .iter()
        .filter(|v| v.max_part > 0 && v.max_part < 8 << 20)
    {
        out.push(format!(
            "Volume {} of policy {} takes no part larger than {} bytes, which most merges \
             exceed — parts will skip it and land on the next volume down.",
            v.volume, v.policy, v.max_part
        ));
    }

    out
}

fn policies(volumes: &[Volume]) -> Vec<String> {
    let mut out: Vec<String> = volumes.iter().map(|v| v.policy.clone()).collect();
    out.sort();
    out.dedup();
    out
}

fn same_filesystem(names: &[String], disks: &[Disk]) -> bool {
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    same_filesystem_names(&refs, disks)
}

/// Whether these disks all report the same free and total space.
///
/// Two separate filesystems agreeing to the byte is implausible, and one disk is
/// not evidence of anything.
fn same_filesystem_names(names: &[&str], disks: &[Disk]) -> bool {
    let found: Vec<&Disk> = names
        .iter()
        .filter_map(|n| disks.iter().find(|d| d.name == *n))
        .collect();
    found.len() > 1
        && found
            .windows(2)
            .all(|w| w[0].free == w[1].free && w[0].total == w[1].total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(name: &str, free: u64, total: u64) -> Disk {
        Disk {
            name: name.into(),
            path: format!("/var/lib/clickhouse/{name}/"),
            free,
            total,
            kind: "local".into(),
            used_by: Vec::new(),
        }
    }

    fn volume(policy: &str, name: &str, priority: u64, disks: &[&str], move_factor: f64) -> Volume {
        Volume {
            policy: policy.into(),
            volume: name.into(),
            priority,
            disks: disks.iter().map(|s| s.to_string()).collect(),
            kind: "JBOD".into(),
            max_part: 0,
            move_factor,
            draining: false,
            free_ratio: 0.0,
        }
    }

    #[test]
    fn a_disk_in_no_policy_is_named_as_capacity_that_is_not() {
        let mut disks = vec![disk("default", 50, 100), disk("backups", 50, 100)];
        let mut volumes = vec![volume("default", "default", 1, &["default"], 0.0)];
        attach(&mut disks, &mut volumes);
        // In the order they were built, not sorted: `attach` does not reorder.
        assert_eq!(disks[0].name, "default");
        assert_eq!(disks[0].used_by, ["default"]);
        assert_eq!(disks[1].used_by, Vec::<String>::new());
        let out = verdicts(&disks, &volumes);
        assert!(out
            .iter()
            .any(|v| v.contains("Disk backups belongs to no storage policy")));
    }

    #[test]
    fn the_mover_is_firing_when_free_space_is_under_the_factor() {
        // Measured on a real server before it was written down: free ratio
        // 0.197 against a move factor of 0.2, and a partition moved onto the hot
        // volume by hand was gone in three seconds.
        let mut disks = vec![disk("default", 197, 1000), disk("cold", 900, 1000)];
        let mut volumes = vec![
            volume("tiered", "hot", 1, &["default"], 0.2),
            volume("tiered", "cold", 2, &["cold"], 0.2),
        ];
        attach(&mut disks, &mut volumes);
        assert!(volumes[0].draining);
        assert!((volumes[0].free_ratio - 0.197).abs() < 1e-9);
        // The cold volume has room, so it is not being drained even though the
        // factor is the policy's and applies to both.
        assert!(!volumes[1].draining);

        let out = verdicts(&disks, &volumes);
        assert!(out[0].contains("being drained now"));
        assert!(out[0].contains("will leave again within seconds"));
    }

    #[test]
    fn the_lowest_volume_is_never_drained_however_full_it_is() {
        // The mover moves data downward, so the last volume of a policy has
        // nowhere to send anything. The page said otherwise once, on a fixture
        // where the partition it claimed was leaving had sat still.
        let mut disks = vec![disk("default", 100, 1000), disk("cold", 100, 1000)];
        let mut volumes = vec![
            volume("tiered", "hot", 1, &["default"], 0.2),
            volume("tiered", "cold", 2, &["cold"], 0.2),
        ];
        attach(&mut disks, &mut volumes);
        assert!(volumes[0].draining, "hot has cold below it");
        assert!(!volumes[1].draining, "cold has nothing below it");
        let out = verdicts(&disks, &volumes);
        assert_eq!(
            out.iter()
                .filter(|v| v.contains("being drained now"))
                .count(),
            1
        );
    }

    #[test]
    fn a_single_volume_policy_is_never_drained_either() {
        let mut disks = vec![disk("default", 1, 1000)];
        let mut volumes = vec![volume("default", "default", 1, &["default"], 0.9)];
        attach(&mut disks, &mut volumes);
        assert!(!volumes[0].draining);
    }

    #[test]
    fn a_move_factor_of_zero_never_drains_however_full_it_is() {
        let mut disks = vec![disk("default", 1, 1000)];
        let mut volumes = vec![volume("default", "default", 1, &["default"], 0.0)];
        attach(&mut disks, &mut volumes);
        assert!(!volumes[0].draining);
        assert!(!verdicts(&disks, &volumes)
            .iter()
            .any(|v| v.contains("drained")));
    }

    #[test]
    fn the_fullest_disk_in_a_volume_decides() {
        // It is the one that runs out first, and the mover watches the volume.
        // A second volume below it, so the draining question is a real one.
        let mut disks = vec![
            disk("a", 900, 1000),
            disk("b", 100, 1000),
            disk("down", 900, 1000),
        ];
        let mut volumes = vec![
            volume("p", "v", 1, &["a", "b"], 0.2),
            volume("p", "below", 2, &["down"], 0.2),
        ];
        attach(&mut disks, &mut volumes);
        // 0.1 from disk `b`, not 0.9 from `a` and not the mean of the two.
        assert!((volumes[0].free_ratio - 0.1).abs() < 1e-9);
        assert!(volumes[0].draining);
    }

    #[test]
    fn a_volume_whose_disk_reports_no_size_is_not_divided_by() {
        let mut disks = vec![disk("weird", 0, 0)];
        let mut volumes = vec![volume("p", "v", 1, &["weird"], 0.2)];
        attach(&mut disks, &mut volumes);
        assert_eq!(volumes[0].free_ratio, 0.0);
        assert!(!volumes[0].draining);
    }

    #[test]
    fn a_tier_across_one_filesystem_is_not_a_tier() {
        // Two disks agreeing to the byte are one filesystem, near enough — and
        // this is exactly what the development fixture looks like.
        let mut disks = vec![disk("default", 500, 1000), disk("cold", 500, 1000)];
        let mut volumes = vec![
            volume("tiered", "hot", 1, &["default"], 0.0),
            volume("tiered", "cold", 2, &["cold"], 0.0),
        ];
        attach(&mut disks, &mut volumes);
        let out = verdicts(&disks, &volumes);
        assert!(out.iter().any(|v| v.contains("not a tier")));
    }

    #[test]
    fn disks_that_differ_are_not_accused_of_sharing() {
        let mut disks = vec![disk("default", 500, 1000), disk("cold", 900, 2000)];
        let mut volumes = vec![
            volume("tiered", "hot", 1, &["default"], 0.0),
            volume("tiered", "cold", 2, &["cold"], 0.0),
        ];
        attach(&mut disks, &mut volumes);
        assert!(!verdicts(&disks, &volumes)
            .iter()
            .any(|v| v.contains("one filesystem")));
    }

    #[test]
    fn a_volume_too_small_for_a_merge_says_so() {
        let mut disks = vec![disk("default", 500, 1000)];
        let mut volumes = vec![volume("p", "tiny", 1, &["default"], 0.0)];
        volumes[0].max_part = 1_048_576;
        attach(&mut disks, &mut volumes);
        let out = verdicts(&disks, &volumes);
        assert!(out.iter().any(|v| v.contains("parts will skip it")));
    }
}
