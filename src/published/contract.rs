//! What a revision promises about its parameters and its columns.
//!
//! The statement's `{name:Type}` placeholders already say what an endpoint
//! *needs*. They say nothing about what it will *accept*, and the gap between
//! those two is where every unhappy morning with a published API comes from: a
//! caller asks for four years of a table partitioned by day and the cluster
//! notices; a caller asks for `device_id` and gets it, because the statement
//! selected it for a join and nobody meant it to leave the building.
//!
//! So a contract is a separate, explicit thing, and it is deliberately made of
//! *refusals* rather than transformations. A window wider than the cap is
//! refused with the cap in the sentence; it is not quietly narrowed. A column
//! that is not exposed is refused by name; it is not silently dropped from the
//! answer. A caller who gets fewer columns than they asked for and no error has
//! been lied to, and will find out weeks later.
//!
//! Every rule is optional and an empty contract promises exactly what the
//! placeholders do — which is how every endpoint published before this module
//! existed goes on behaving.

use serde::{Deserialize, Serialize};

/// The whole of a revision's promises.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Contract {
    /// One rule per statement placeholder that has one. A placeholder with no
    /// rule here is unconstrained beyond its declared ClickHouse type.
    #[serde(default)]
    pub params: Vec<ParamRule>,
    /// Which of the statement's columns may leave the building.
    #[serde(default)]
    pub columns: Exposure,
    /// The columns `?order=` will accept, in the order the page should offer
    /// them. Empty means sorting is not offered at all — which is the honest
    /// spelling for a statement whose own `ORDER BY` is the point.
    #[serde(default)]
    pub order_by: Vec<String>,
    /// A ceiling on `?limit=` below the revision's `max_rows`. Absent leaves
    /// `max_rows` as the only ceiling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_limit: Option<u64>,
}

/// A promise about one parameter.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ParamRule {
    pub name: String,
    /// Lexicographic for text, numeric for numbers, and a date compares
    /// correctly either way in ISO form — which is the only form ClickHouse
    /// accepts here anyway.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub min: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub max: String,
    /// The only values accepted. Empty is no restriction; a non-empty list is
    /// exhaustive, and the refusal names every member of it, because a caller
    /// told `region` is invalid without being told what is valid has to come
    /// and ask a person.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub one_of: Vec<String>,
    /// The far end of a window this parameter opens, and how wide it may get.
    ///
    /// Stated on one of the pair rather than beside them, because a window is
    /// a relationship and putting half of it on each parameter gives you two
    /// places to disagree.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub window_to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_days: Option<u32>,
    /// A sentence for the caller that the rules above cannot express. Shown
    /// verbatim, in the document and on the page.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// Which columns of the statement's result a caller may receive.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Exposure {
    /// An allow-list. Empty means every column the statement returns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub only: Vec<String>,
    /// A deny-list, applied after the allow-list — so a column named in both
    /// is denied. Belt and braces on purpose: `only` is a decision about what
    /// this endpoint is for, `never` is a decision about a column that must
    /// not leave whatever anybody later adds to `only`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub never: Vec<String>,
}

impl Contract {
    /// Read a stored contract. An unparseable one is an empty one rather than
    /// an error: the alternative is an endpoint that stops answering because
    /// something wrote bad JSON into a column, and a contract that promises
    /// nothing is the state every endpoint was in before contracts existed.
    ///
    /// It is not silent — the caller of this decides what to say — but it is
    /// never fatal on the serving path.
    pub fn parse(raw: &str) -> Contract {
        if raw.trim().is_empty() {
            return Contract::default();
        }
        serde_json::from_str(raw).unwrap_or_default()
    }

    /// The same, refusing rather than shrugging. Used where a contract is
    /// being *written*, which is the moment a mistake is still cheap.
    pub fn validate(raw: &str) -> Result<Contract, String> {
        if raw.trim().is_empty() {
            return Ok(Contract::default());
        }
        let contract: Contract =
            serde_json::from_str(raw).map_err(|e| format!("this contract is not valid: {e}"))?;
        for rule in &contract.params {
            if rule.name.trim().is_empty() {
                return Err("a parameter rule with no parameter name promises nothing".into());
            }
            if rule.window_days.is_some() && rule.window_to.trim().is_empty() {
                return Err(format!(
                    "`{}` caps a window at {} days without saying which parameter closes it — \
                     set `window_to` to the other end of the pair",
                    rule.name,
                    rule.window_days.unwrap_or_default()
                ));
            }
        }
        Ok(contract)
    }

    pub fn rule(&self, name: &str) -> Option<&ParamRule> {
        self.params.iter().find(|r| r.name == name)
    }

    /// Whether this contract says anything at all.
    pub fn is_empty(&self) -> bool {
        self.params.is_empty()
            && self.columns.only.is_empty()
            && self.columns.never.is_empty()
            && self.order_by.is_empty()
            && self.max_limit.is_none()
    }

    /// Whether a column may be returned.
    pub fn exposes(&self, column: &str) -> bool {
        if self.columns.never.iter().any(|c| c == column) {
            return false;
        }
        self.columns.only.is_empty() || self.columns.only.iter().any(|c| c == column)
    }

    /// The exposed subset of what the statement actually returns, in the
    /// statement's own order.
    ///
    /// `only` is not itself the answer: it can name a column the statement
    /// stopped returning three revisions ago, and an endpoint that promises a
    /// column it cannot produce is worse than one that promises less.
    pub fn exposed<'a>(&self, returned: &'a [String]) -> Vec<&'a String> {
        returned.iter().filter(|c| self.exposes(c)).collect()
    }

    /// Check the values a caller supplied against the promises.
    ///
    /// `bound` is every parameter with its final value — the caller's where
    /// they gave one, the endpoint's default where they did not. Defaults are
    /// checked too, deliberately: a default that violates the contract is a
    /// mistake in the endpoint, and finding it on the first call is better
    /// than finding it on the first call that happened to omit the parameter.
    pub fn check(&self, bound: &[(String, String)]) -> Result<(), Refusal> {
        for rule in &self.params {
            let Some((_, value)) = bound.iter().find(|(name, _)| *name == rule.name) else {
                continue;
            };
            if !rule.one_of.is_empty() && !rule.one_of.iter().any(|v| v == value) {
                return Err(Refusal::bad(
                    format!("`{}` is not one of {}", rule.name, list(&rule.one_of)),
                    format!("{} not accepted", rule.name),
                ));
            }
            // Numbers compare as numbers and everything else as text. A date
            // in ISO form sorts correctly as text, which is the whole reason
            // ClickHouse's date literals are written that way.
            if !rule.min.is_empty() && below(value, &rule.min) {
                return Err(Refusal::bad(
                    format!("`{}` may be no earlier than {}", rule.name, rule.min),
                    format!("{} before the floor", rule.name),
                ));
            }
            if !rule.max.is_empty() && below(&rule.max, value) {
                return Err(Refusal::bad(
                    format!("`{}` may be no later than {}", rule.name, rule.max),
                    format!("{} past the ceiling", rule.name),
                ));
            }
            if let (Some(days), false) = (rule.window_days, rule.window_to.is_empty()) {
                let far = bound
                    .iter()
                    .find(|(name, _)| *name == rule.window_to)
                    .map(|(_, v)| v.as_str());
                // No far end supplied means no window to measure. Not an
                // error: the pair may both be optional, and refusing a call
                // for a parameter the caller was never required to send would
                // be a rule nobody could satisfy.
                if let Some(far) = far {
                    if let Some(span) = span_days(value, far) {
                        if span > i64::from(days) {
                            return Err(Refusal::bad(
                                format!(
                                    "`{}` to `{}` is {} days; this endpoint answers windows of \
                                     at most {}",
                                    rule.name, rule.window_to, span, days
                                ),
                                format!("window wider than {days} days"),
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Check the columns a caller named against what may leave.
    ///
    /// Refused rather than filtered, and by name: a caller who asked for
    /// `device_id` and got an answer without it would conclude the column is
    /// empty.
    pub fn check_columns(&self, asked: &[String]) -> Result<(), Refusal> {
        for column in asked {
            if !self.exposes(column) {
                return Err(Refusal::forbidden(
                    format!("`{column}` is not exposed by this endpoint"),
                    format!("column {column} not exposed"),
                ));
            }
        }
        Ok(())
    }

    /// Check the sort a caller asked for.
    ///
    /// Only where the contract names an allow-list. An endpoint with no
    /// `order_by` list sorts however `shape` already allowed, which is what
    /// every endpoint did before contracts.
    pub fn check_order(&self, asked: &[String]) -> Result<(), Refusal> {
        if self.order_by.is_empty() {
            return Ok(());
        }
        for column in asked {
            if !self.order_by.iter().any(|c| c == column) {
                return Err(Refusal::bad(
                    format!(
                        "this endpoint sorts by {} — `{column}` is not offered",
                        list(&self.order_by)
                    ),
                    format!("sort on {column} not offered"),
                ));
            }
        }
        Ok(())
    }

    /// The ceiling on a page, given the revision's own.
    pub fn ceiling(&self, max_rows: u64) -> u64 {
        match self.max_limit {
            Some(cap) => cap.min(max_rows).max(1),
            None => max_rows,
        }
    }
}

/// A call the contract turned away.
///
/// Carries two sentences on purpose. `told` goes to the caller and is written
/// for somebody debugging their own script. `logged` goes in the call log and
/// is written to be *grouped* — it holds no value the caller supplied, so a
/// thousand refusals over a week collapse into one line with a count beside
/// it rather than a thousand lines nobody reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub told: String,
    pub logged: String,
}

impl Refusal {
    fn bad(told: String, logged: String) -> Refusal {
        Refusal {
            status: 400,
            told,
            logged,
        }
    }

    fn forbidden(told: String, logged: String) -> Refusal {
        Refusal {
            status: 403,
            told,
            logged,
        }
    }
}

/// `a`, `b` or `c` — the Oxford-comma-free version, because these are values
/// and a comma inside one would already have broken the sentence.
fn list(values: &[String]) -> String {
    values
        .iter()
        .map(|v| format!("`{v}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Whether `a` sorts before `b`, numerically where both are numbers.
fn below(a: &str, b: &str) -> bool {
    match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
        (Ok(a), Ok(b)) => a < b,
        _ => a < b,
    }
}

/// Days between two ISO moments, or nothing where either is not one.
///
/// Nothing rather than zero: a value ClickHouse would refuse should be refused
/// by ClickHouse, with ClickHouse's own message about the type, rather than
/// silently passing a window check it could not be measured against.
fn span_days(from: &str, to: &str) -> Option<i64> {
    let day = |raw: &str| -> Option<i64> {
        let date = raw.trim().get(..10)?;
        let mut parts = date.split('-');
        let y: i64 = parts.next()?.parse().ok()?;
        let m: i64 = parts.next()?.parse().ok()?;
        let d: i64 = parts.next()?.parse().ok()?;
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return None;
        }
        // Days since an arbitrary epoch — only the difference is ever used, so
        // the epoch and the leap-year arithmetic only have to be consistent,
        // and this is the standard civil-from-days inversion.
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        Some(era * 146_097 + doe - 719_468)
    };
    Some((day(to)? - day(from)?).abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bound(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn an_empty_contract_promises_what_the_placeholders_do() {
        let contract = Contract::parse("");
        assert!(contract.is_empty());
        assert!(contract.check(&bound(&[("anything", "at all")])).is_ok());
        assert!(contract.exposes("device_id"));
        assert_eq!(contract.ceiling(1000), 1000);
    }

    #[test]
    fn unparseable_stored_json_does_not_take_an_endpoint_off_the_air() {
        assert!(Contract::parse("{ not json").is_empty());
        // …but it is refused at the moment somebody tries to save it.
        assert!(Contract::validate("{ not json").is_err());
    }

    #[test]
    fn a_value_outside_the_enum_is_refused_and_told_what_is_inside_it() {
        let contract = Contract {
            params: vec![ParamRule {
                name: "region".into(),
                one_of: vec!["eu-west".into(), "us-east".into()],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(contract.check(&bound(&[("region", "eu-west")])).is_ok());
        let refused = contract.check(&bound(&[("region", "mars")])).unwrap_err();
        assert_eq!(refused.status, 400);
        assert!(refused.told.contains("eu-west"), "{}", refused.told);
        assert!(refused.told.contains("us-east"), "{}", refused.told);
    }

    #[test]
    fn a_floor_compares_dates_as_dates_and_numbers_as_numbers() {
        let contract = Contract {
            params: vec![
                ParamRule {
                    name: "from".into(),
                    min: "2024-01-01".into(),
                    ..Default::default()
                },
                ParamRule {
                    name: "limit".into(),
                    max: "1000".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert!(contract.check(&bound(&[("from", "2024-06-01")])).is_ok());
        assert!(contract.check(&bound(&[("from", "2023-12-31")])).is_err());
        // Text comparison would put "9" above "1000" and let it through.
        assert!(contract.check(&bound(&[("limit", "9")])).is_ok());
        assert!(contract.check(&bound(&[("limit", "1001")])).is_err());
    }

    #[test]
    fn a_window_is_measured_across_the_pair_and_named_in_the_refusal() {
        let contract = Contract {
            params: vec![ParamRule {
                name: "from".into(),
                window_to: "to".into(),
                window_days: Some(90),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(contract
            .check(&bound(&[("from", "2026-01-01"), ("to", "2026-03-01")]))
            .is_ok());
        let refused = contract
            .check(&bound(&[("from", "2025-01-01"), ("to", "2026-01-01")]))
            .unwrap_err();
        assert_eq!(refused.logged, "window wider than 90 days");
        assert!(refused.told.contains("365"), "{}", refused.told);
    }

    #[test]
    fn a_window_with_no_far_end_supplied_is_not_a_violation() {
        let contract = Contract {
            params: vec![ParamRule {
                name: "from".into(),
                window_to: "to".into(),
                window_days: Some(90),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(contract.check(&bound(&[("from", "2020-01-01")])).is_ok());
    }

    #[test]
    fn a_window_cap_with_no_far_end_named_is_refused_when_it_is_written() {
        let raw = r#"{"params":[{"name":"from","window_days":90}]}"#;
        let problem = Contract::validate(raw).unwrap_err();
        assert!(problem.contains("window_to"), "{problem}");
    }

    #[test]
    fn a_denied_column_stays_denied_even_when_the_allow_list_names_it() {
        let contract = Contract {
            columns: Exposure {
                only: vec!["day".into(), "device_id".into()],
                never: vec!["device_id".into()],
            },
            ..Default::default()
        };
        assert!(contract.exposes("day"));
        assert!(!contract.exposes("device_id"));
        assert!(!contract.exposes("latency_ms"));
    }

    #[test]
    fn an_unexposed_column_is_refused_by_name_rather_than_dropped() {
        let contract = Contract {
            columns: Exposure {
                never: vec!["device_id".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let refused = contract
            .check_columns(&["day".into(), "device_id".into()])
            .unwrap_err();
        assert_eq!(refused.status, 403);
        assert_eq!(refused.logged, "column device_id not exposed");
    }

    #[test]
    fn the_exposed_list_is_what_the_statement_returns_not_what_was_promised() {
        let contract = Contract {
            columns: Exposure {
                only: vec!["day".into(), "gone_three_revisions_ago".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let returned = vec!["day".to_string(), "events".to_string()];
        let exposed: Vec<&str> = contract
            .exposed(&returned)
            .iter()
            .map(|c| c.as_str())
            .collect();
        assert_eq!(exposed, vec!["day"]);
    }

    #[test]
    fn an_order_allow_list_only_bites_when_there_is_one() {
        let open = Contract::default();
        assert!(open.check_order(&["anything".into()]).is_ok());
        let closed = Contract {
            order_by: vec!["day".into(), "events".into()],
            ..Default::default()
        };
        assert!(closed.check_order(&["events".into()]).is_ok());
        assert!(closed.check_order(&["cost".into()]).is_err());
    }

    #[test]
    fn the_lower_of_the_two_ceilings_wins_and_it_is_never_zero() {
        let contract = Contract {
            max_limit: Some(100),
            ..Default::default()
        };
        assert_eq!(contract.ceiling(1000), 100);
        assert_eq!(contract.ceiling(50), 50);
        assert_eq!(
            Contract {
                max_limit: Some(0),
                ..Default::default()
            }
            .ceiling(1000),
            1
        );
    }

    #[test]
    fn a_contract_survives_the_round_trip_through_the_column_it_is_stored_in() {
        let contract = Contract {
            params: vec![ParamRule {
                name: "region".into(),
                one_of: vec!["eu-west".into()],
                note: "the fleet's own regions".into(),
                ..Default::default()
            }],
            columns: Exposure {
                only: vec!["day".into()],
                never: vec!["device_id".into()],
            },
            order_by: vec!["day".into()],
            max_limit: Some(1000),
        };
        let raw = serde_json::to_string(&contract).unwrap();
        assert_eq!(Contract::validate(&raw).unwrap(), contract);
    }
}
