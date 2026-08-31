//! Which ClickHouse this actually is.
//!
//! `system.build_options` is seventy-six rows of build variables, and almost all
//! of it is compiler flags nobody reads. Four things in it answer questions
//! nothing else on the server answers:
//!
//! - **Whether this is an official build.** `VERSION_OFFICIAL` holds
//!   `" (official build)"` on one and is empty on anything else. A custom build
//!   is a legitimate thing to run and a fact worth knowing before wondering why
//!   behaviour does not match the documentation.
//! - **What kind of build.** `BUILD_TYPE` is `RelWithDebInfo` on a release and
//!   `Debug` on something that will be several times slower for reasons no query
//!   plan explains. `WITH_COVERAGE` being on is the same class of surprise.
//! - **Which timezone database it was built against.** `TZDATA_VERSION` decides
//!   how `toTimeZone` and every `DateTime` conversion behave, and a stale one is
//!   wrong quietly — no error, just the wrong hour for a zone whose rules changed.
//! - **Which optional features are compiled in.** Forty-four `USE_*` flags, and
//!   the ones that are *off* are the answer to "why can this server not do that":
//!   a build without `USE_AWS_S3` cannot back up to S3 and says so nowhere else.
//!   On the official build all forty-four are on, which is worth stating as the
//!   answer rather than leaving an empty list to be read as a failure to look.

use serde::{Deserialize, Serialize};

use super::{Client, Reach};
use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
pub struct BuildReport {
    /// `26.7.5.10`.
    pub version: String,
    /// `v26.7.5.10-stable`, which carries the channel the plain version does not.
    pub describe: String,
    /// Whether the server calls itself an official build.
    pub official: bool,
    /// `RelWithDebInfo`, `Release`, `Debug`.
    pub build_type: String,
    pub git_hash: String,
    pub git_branch: String,
    pub git_date: String,
    pub platform: String,
    pub compiler: String,
    /// The libraries whose version changes what queries *return* rather than how
    /// fast they run.
    pub tzdata: String,
    pub openssl: String,
    /// Optional features compiled out. Empty on an official build, which the
    /// count below says out loud rather than leaving to be inferred.
    pub missing: Vec<String>,
    pub features_total: u64,
    /// What is worth remarking on, in the order worth reading.
    pub verdicts: Vec<String>,
    /// Why there is nothing here, when there is nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

fn empty(blocked: String) -> BuildReport {
    BuildReport {
        version: String::new(),
        describe: String::new(),
        official: false,
        build_type: String::new(),
        git_hash: String::new(),
        git_branch: String::new(),
        git_date: String::new(),
        platform: String::new(),
        compiler: String::new(),
        tzdata: String::new(),
        openssl: String::new(),
        missing: Vec::new(),
        features_total: 0,
        verdicts: Vec::new(),
        blocked: Some(blocked),
    }
}

pub async fn build(ch: &Client) -> Result<BuildReport> {
    let blocked = match ch.reach("build_options").await? {
        Reach::Readable => None,
        Reach::Denied => Some("this user cannot read system.build_options".to_string()),
        Reach::Absent | Reach::Unconfigured => {
            Some("this ClickHouse has no system.build_options".to_string())
        }
    };
    if let Some(reason) = blocked {
        return Ok(empty(reason));
    }

    #[derive(Deserialize)]
    struct Row {
        name: String,
        value: String,
    }
    let rows: Vec<Row> = ch
        .rows("SELECT name AS name, value AS value FROM system.build_options")
        .await?;
    let get = |key: &str| -> String {
        rows.iter()
            .find(|r| r.name == key)
            .map(|r| r.value.trim().to_string())
            .unwrap_or_default()
    };

    let features: Vec<&Row> = rows.iter().filter(|r| r.name.starts_with("USE_")).collect();
    let missing: Vec<String> = features
        .iter()
        .filter(|r| is_off(&r.value))
        .map(|r| r.name.trim_start_matches("USE_").to_lowercase())
        .collect();

    let report = BuildReport {
        version: get("VERSION_STRING"),
        describe: get("VERSION_DESCRIBE"),
        // Empty means it is not one, which is the whole reason to read this
        // column rather than the version string beside it.
        official: !get("VERSION_OFFICIAL").is_empty(),
        build_type: get("BUILD_TYPE"),
        git_hash: get("GIT_HASH"),
        git_branch: get("GIT_BRANCH"),
        git_date: get("GIT_DATE"),
        platform: format!("{} {}", get("SYSTEM"), get("SYSTEM_PROCESSOR"))
            .trim()
            .to_string(),
        compiler: format!(
            "{} {}",
            compiler_name(&get("CXX_COMPILER")),
            get("CXX_COMPILER_VERSION")
        )
        .trim()
        .to_string(),
        tzdata: get("TZDATA_VERSION"),
        openssl: get("OPENSSL_VERSION"),
        features_total: features.len() as u64,
        verdicts: verdicts(
            &get("VERSION_OFFICIAL"),
            &get("BUILD_TYPE"),
            &get("WITH_COVERAGE"),
            &missing,
        ),
        missing,
        blocked: None,
    };
    Ok(report)
}

/// Whether a build flag reads as off.
///
/// The values are not consistent: `USE_JEMALLOC` is `1` and
/// `USE_EMBEDDED_COMPILER` is `ON`, so their opposites are `0` and `OFF`, and an
/// absent one is empty. All three mean the same thing here.
pub fn is_off(value: &str) -> bool {
    matches!(value.trim(), "0" | "OFF" | "off" | "" | "FALSE" | "false")
}

/// The compiler without the path it was installed at.
fn compiler_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// What is worth saying about how this server was built.
pub fn verdicts(
    official: &str,
    build_type: &str,
    coverage: &str,
    missing: &[String],
) -> Vec<String> {
    let mut out = Vec::new();

    if official.trim().is_empty() {
        out.push(
            "This is not an official build. That is a legitimate thing to run and it is worth \
             knowing before comparing behaviour against the documentation."
                .to_string(),
        );
    }
    // A debug build is several times slower for reasons no query plan explains.
    if build_type.eq_ignore_ascii_case("debug") {
        out.push(
            "It is a Debug build. Everything on this server is several times slower than a \
             release, and no query plan will say why."
                .to_string(),
        );
    }
    if !is_off(coverage) {
        out.push(
            "It was built with coverage instrumentation, which is slower again and is not a \
             thing to run outside a test."
                .to_string(),
        );
    }
    if !missing.is_empty() {
        out.push(format!(
            "Compiled without {}. Anything that needs {} will fail on this server however it is \
             configured.",
            missing.join(", "),
            if missing.len() == 1 { "it" } else { "them" }
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flags_are_spelled_three_different_ways() {
        // `USE_JEMALLOC` is `1`, `USE_EMBEDDED_COMPILER` is `ON`, and an absent
        // one is empty. All three opposites mean the same thing.
        assert!(is_off("0"));
        assert!(is_off("OFF"));
        assert!(is_off(""));
        assert!(is_off("  "));
        assert!(!is_off("1"));
        assert!(!is_off("ON"));
    }

    #[test]
    fn an_official_release_build_says_nothing() {
        // Which is the whole point: the panel is quiet on the ordinary server and
        // speaks up on the one that needs explaining.
        assert!(verdicts(" (official build)", "RelWithDebInfo", "OFF", &[]).is_empty());
    }

    #[test]
    fn an_unofficial_build_is_stated_and_not_judged() {
        let out = verdicts("", "RelWithDebInfo", "OFF", &[]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("legitimate thing to run"));
    }

    #[test]
    fn a_debug_build_says_what_it_costs() {
        let out = verdicts(" (official build)", "Debug", "OFF", &[]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("several times slower"));
        assert!(out[0].contains("no query plan will say why"));
    }

    #[test]
    fn coverage_instrumentation_is_its_own_remark() {
        let out = verdicts(" (official build)", "RelWithDebInfo", "ON", &[]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("coverage"));
    }

    #[test]
    fn a_missing_feature_says_what_will_fail_and_agrees_with_itself() {
        let one = verdicts(" (official build)", "Release", "OFF", &["aws_s3".into()]);
        assert!(one[0].contains("Compiled without aws_s3"));
        assert!(one[0].contains("needs it will fail"));

        let two = verdicts(
            " (official build)",
            "Release",
            "OFF",
            &["aws_s3".into(), "krb5".into()],
        );
        assert!(two[0].contains("aws_s3, krb5"));
        assert!(two[0].contains("needs them will fail"));
    }

    #[test]
    fn everything_wrong_at_once_is_four_sentences_in_order() {
        let out = verdicts("", "Debug", "ON", &["hdfs".into()]);
        assert_eq!(out.len(), 4);
        assert!(out[0].contains("not an official build"));
        assert!(out[1].contains("Debug build"));
        assert!(out[2].contains("coverage"));
        assert!(out[3].contains("hdfs"));
    }

    #[test]
    fn the_compiler_loses_the_path_it_was_installed_at() {
        assert_eq!(compiler_name("/usr/local/bin/clang++-21"), "clang++-21");
        assert_eq!(compiler_name("clang++"), "clang++");
    }
}
