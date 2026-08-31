//! When, as a first-class part of the question.
//!
//! Every one of these could be written as two filters on a timestamp, and until
//! now that is what a caller had to do. It works, and it is where the mistakes
//! are: a closed interval that counts the boundary row twice, a "last month"
//! that is thirty days, a bucket built by hand out of `toStartOfDay` that a
//! caller cannot express at all because the filter language has no functions.
//!
//! So the three things people actually ask for are named rather than assembled:
//!
//! - **`last`** — a rolling window ending now. Seven days is 7 × 24 hours.
//! - **`period`** — a calendar window, aligned to its own boundaries.
//!   `previous_month` is a month, whatever length that month happens to be.
//! - **`from`/`to`** — the exact window, written out.
//!
//! *`last` rolls, `period` aligns* is the whole of the distinction, and it is
//! worth keeping in those words: the two answer different questions and a caller
//! who reaches for the wrong one gets a plausible number.
//!
//! **The clock is ClickHouse's**, never Flint's. `now()` is rendered into the
//! statement rather than resolved here — the same decision `workspace.rs`
//! already made — so a sidecar whose clock has drifted cannot return a window
//! that disagrees with `system.query_log`. The cost is that Flint cannot print
//! the exact boundaries back, and the honest answer to "which window did I get"
//! is to ask for it: `{"aggregation": "min", "column": "ts"}`.

use serde::Deserialize;

use crate::clickhouse::ColumnMeta;
use crate::dataset::inventory::{kind_of, Kind};
use crate::published::shape::{Aggregate, Bucket, Comparison, Edge, Shape, Unit, Window};

/// What a second window is, relative to the first.
///
/// Two, and they are the two questions people ask: *is this better than last
/// time* and *is this better than the same time last year*. A month against the
/// month before it catches a trend; a December against the December before it
/// is the only way to read a business with a season.
const COMPARISONS: [&str; 2] = ["previous_period", "previous_year"];

/// The comparisons there are, for whoever documents them.
pub fn comparisons() -> Vec<&'static str> {
    COMPARISONS.to_vec()
}

/// A calendar window, named.
///
/// Half-open, every one of them: `[start, end)`. Walk a month at a time over
/// closed intervals and every boundary row lands in two answers.
const PERIODS: [(&str, Unit, i64); 10] = [
    ("this_hour", Unit::Hour, 0),
    ("previous_hour", Unit::Hour, -1),
    ("today", Unit::Day, 0),
    ("yesterday", Unit::Day, -1),
    ("this_week", Unit::Week, 0),
    ("previous_week", Unit::Week, -1),
    ("this_month", Unit::Month, 0),
    ("previous_month", Unit::Month, -1),
    ("this_year", Unit::Year, 0),
    ("previous_year", Unit::Year, -1),
];

pub fn period_names() -> Vec<&'static str> {
    PERIODS.iter().map(|(name, _, _)| *name).collect()
}

/// One `time`, or several.
///
/// One is what almost every request sends and what the documentation shows, so
/// it stays the shape it was. Several is for the questions that have more than
/// one time in them — "created last week and updated today", or a day column
/// beside an hour column — which the Builder could always ask and which a
/// single object could not hold.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum TimeSpecs {
    One(Box<TimeSpec>),
    Several(Vec<TimeSpec>),
}

impl TimeSpecs {
    pub fn into_plans(self) -> Result<Vec<Plan>, String> {
        match self {
            TimeSpecs::One(spec) => Ok(vec![spec.into_plan()?]),
            TimeSpecs::Several(specs) => {
                if specs.is_empty() {
                    return Err("`time` was given no windows at all".into());
                }
                specs.into_iter().map(TimeSpec::into_plan).collect()
            }
        }
    }
}

/// The time half of a request, as JSON writes it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeSpec {
    /// Which column. Absent means the dataset's own, where it has exactly one.
    #[serde(default)]
    pub column: Option<String>,
    /// A rolling window: `{"last": 7, "unit": "days"}`.
    #[serde(default)]
    pub last: Option<u32>,
    #[serde(default)]
    pub unit: Option<String>,
    /// A calendar window: `{"period": "previous_month"}`.
    #[serde(default)]
    pub period: Option<String>,
    /// An exact window, half-open like the others.
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    /// Bucket the column, turning the answer into a series.
    #[serde(default)]
    pub granularity: Option<String>,
    /// Ask the same question of a second window: `previous_period` or
    /// `previous_year`.
    #[serde(default)]
    pub compare: Option<String>,
}

/// A time spec that has been read, but whose column may still be unknown.
///
/// Resolving the column needs the dataset described, and describing it is a
/// round trip — so the two halves are kept apart: what the caller meant is
/// settled here, and which column they meant is settled in [`Plan::apply`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    column: Option<String>,
    from: Option<Edge>,
    to: Option<Edge>,
    granularity: Option<Unit>,
    /// The second window, already worked out — see [`TimeSpec::into_plan`].
    compare: Option<(Edge, Edge)>,
}

impl Plan {
    /// Whether this plan turns the answer into groups.
    pub fn buckets(&self) -> bool {
        self.granularity.is_some()
    }

    /// Whether this plan asks for a second window.
    pub fn compares(&self) -> bool {
        self.compare.is_some()
    }
}

impl TimeSpec {
    pub fn into_plan(self) -> Result<Plan, String> {
        let rolling = self.last.is_some();
        let named = self.period.is_some();
        let exact = self.from.is_some() || self.to.is_some();

        if usize::from(rolling) + usize::from(named) + usize::from(exact) > 1 {
            return Err(
                "a time window is one of `last`, `period` or `from`/`to` — not several at \
                 once, because they would disagree"
                    .into(),
            );
        }

        let (from, to) = if let Some(count) = self.last {
            let keyword = self.unit.as_deref().ok_or(
                "`last` needs the `unit` it counts — minutes, hours, days, weeks, months \
                 or years",
            )?;
            let unit = Unit::from_keyword(keyword).ok_or_else(|| {
                format!(
                    "`{keyword}` is not a unit of time; use one of {}",
                    Unit::keywords().join(", ")
                )
            })?;
            if count == 0 {
                return Err("`last: 0` is a window with nothing in it".into());
            }
            // Ends at now rather than at the end of the current unit: a rolling
            // window that ran into the future would be a calendar one wearing
            // the wrong name.
            (Some(Edge::Ago { unit, count }), Some(Edge::Now))
        } else if let Some(name) = &self.period {
            let (_, unit, shift) = PERIODS
                .iter()
                .find(|(period, _, _)| period == name)
                .ok_or_else(|| {
                    format!(
                        "`{name}` is not a period; use one of {}",
                        period_names().join(", ")
                    )
                })?;
            (
                Some(Edge::StartOf {
                    unit: *unit,
                    shift: *shift,
                }),
                Some(Edge::StartOf {
                    unit: *unit,
                    shift: shift + 1,
                }),
            )
        } else {
            // Either end may be left off, which is how "everything since
            // Tuesday" is written. Both left off is caught below.
            (self.from.map(Edge::Given), self.to.map(Edge::Given))
        };

        // The second window, worked out from the first rather than described
        // again. A comparison is "the same question, moved" — asking a caller
        // to write both windows would let them drift apart, and two windows of
        // different lengths make a difference that is not one.
        let compare = match &self.compare {
            None => None,
            Some(mode) if !COMPARISONS.contains(&mode.as_str()) => {
                return Err(format!(
                    "`{mode}` is not a comparison; use one of {}",
                    COMPARISONS.join(", ")
                ))
            }
            Some(mode) => {
                // Before the shapes below, or "there is no window" comes back
                // as "this window cannot be moved", which sends somebody to
                // rewrite a window they never wrote.
                if from.is_none() {
                    return Err("a comparison needs a window to compare against".into());
                }
                let a_year_back = mode == "previous_year";
                Some(match (&from, &to) {
                    // A calendar window moves by whole units of its own kind,
                    // so `this_month` compared with `previous_period` is the
                    // month before — a month, not thirty days.
                    (
                        Some(Edge::StartOf { unit, shift }),
                        Some(Edge::StartOf {
                            unit: to_unit,
                            shift: to_shift,
                        }),
                    ) if unit == to_unit => {
                        let back = if a_year_back { 0 } else { 1 };
                        let (a, b) = (
                            Edge::StartOf {
                                unit: *unit,
                                shift: shift - back,
                            },
                            Edge::StartOf {
                                unit: *to_unit,
                                shift: to_shift - back,
                            },
                        );
                        if a_year_back {
                            (a.a_year_before(), b.a_year_before())
                        } else {
                            (a, b)
                        }
                    }
                    // A rolling window moves by its own span: the seven days
                    // before the last seven.
                    (Some(Edge::Ago { unit, count }), Some(Edge::Now)) if !a_year_back => (
                        Edge::Ago {
                            unit: *unit,
                            count: count * 2,
                        },
                        Edge::Ago {
                            unit: *unit,
                            count: *count,
                        },
                    ),
                    (Some(Edge::Ago { unit, count }), Some(Edge::Now)) => (
                        Edge::Ago {
                            unit: *unit,
                            count: *count,
                        }
                        .a_year_before(),
                        Edge::Now.a_year_before(),
                    ),
                    // A window written out by hand has a length only the server
                    // can work out, and shifting it here would mean Flint doing
                    // date arithmetic it has deliberately left to ClickHouse.
                    _ => {
                        return Err(
                            "a comparison moves a window, so it needs one Flint can move — \
                             `last` or `period`, not a `from`/`to` written out"
                                .into(),
                        )
                    }
                })
            }
        };

        let granularity = match &self.granularity {
            Some(keyword) => Some(Unit::from_keyword(keyword).ok_or_else(|| {
                format!(
                    "`{keyword}` is not a granularity; use one of {}",
                    Unit::keywords().join(", ")
                )
            })?),
            None => None,
        };

        if from.is_none() && to.is_none() && granularity.is_none() {
            return Err(
                "this `time` asks for nothing — give it a window (`last`, `period`, \
                 `from`/`to`) or a `granularity`"
                    .into(),
            );
        }

        // `unit` belongs to `last`. Sent beside a period it is the leftover of
        // an edit, and honouring the period while ignoring it would hide that.
        if self.unit.is_some() && !rolling {
            return Err("`unit` belongs to `last`; a `period` carries its own".into());
        }

        Ok(Plan {
            column: self.column.filter(|c| !c.trim().is_empty()),
            from,
            to,
            granularity,
            compare,
        })
    }
}

impl Plan {
    /// Attach this plan to the shape, now that the dataset has described itself.
    pub fn apply(self, shape: &mut Shape, columns: &[ColumnMeta]) -> Result<(), String> {
        let column = match self.column {
            Some(named) => named,
            None => sole_time_column(columns)?,
        };

        let window = (self.from.is_some() || self.to.is_some()).then(|| Window {
            column: column.clone(),
            from: self.from,
            to: self.to,
        });

        // A window that is *not* being compared narrows the answer on its own
        // account. The compared one is handed to the comparison instead, which
        // holds the pair — see `Comparison::current` for the bug that taught us
        // they must not be separated.
        if self.compare.is_none() {
            shape.windows.extend(window.clone());
        }

        if let Some((from, to)) = self.compare {
            // The label lands in the same namespace as the dimensions and the
            // metrics, and it arrives after they have been checked against each
            // other — so it checks itself.
            const LABEL: &str = "window";
            if let Some(aggregate) = &shape.aggregate {
                if aggregate.output_names().contains(&LABEL) {
                    return Err(format!(
                        "a comparison labels its two windows in a `{LABEL}` column, and \
                         something in this answer is already called that — rename it \
                         with `as`"
                    ));
                }
            }
            if shape.compare.is_some() {
                return Err(
                    "two comparisons is two answers — a `compare` moves one window, and \
                     only one"
                        .into(),
                );
            }
            let Some(current) = window else {
                return Err("a comparison needs a window to compare against".into());
            };
            shape.compare = Some(Comparison {
                current,
                previous: Window {
                    column: column.clone(),
                    from: Some(from),
                    to: Some(to),
                },
                label: LABEL.to_string(),
            });
        }

        if let Some(unit) = self.granularity {
            // `ts_day`, not `ts`.
            //
            // Naming the bucket after its own column was the first design, and
            // a real query killed it: in ClickHouse an alias shadows a source
            // column of the same name *inside the expression that defines it*,
            // so `SELECT toStartOfDay(ts) AS ts ... GROUP BY toStartOfDay(ts)`
            // groups by something other than what it selected, and the server
            // refuses a statement that reads as though it should work.
            //
            // The replacement is better anyway, which is the usual consolation:
            // `ts_day` says which granularity it is, where `ts` did not, and it
            // matches how a metric is named — `avg_temperature`, `ts_day`, one
            // rule.
            let alias = format!("{column}_{}", unit.keyword());

            // The bucket lands in the same namespace as everything else, and it
            // arrives after the check that found collisions among the rest.
            if let Some(aggregate) = &shape.aggregate {
                // Two buckets on one column at one granularity would be the
                // same column twice; at different granularities they are
                // `ts_day` and `ts_hour`, which is the point.
                if aggregate.output_names().contains(&alias.as_str()) {
                    return Err(format!(
                        "the bucket would be called `{alias}`, and something in this answer \
                         already is — rename it with `as`"
                    ));
                }
            }

            let bucket = Bucket {
                alias,
                column,
                unit,
            };
            match &mut shape.aggregate {
                Some(aggregate) => aggregate.buckets.push(bucket),
                // A granularity on its own is still a group by — "which days
                // are there" is a question, even with nothing measured over it.
                None => {
                    shape.aggregate = Some(Aggregate {
                        buckets: vec![bucket],
                        dimensions: Vec::new(),
                        metrics: Vec::new(),
                        having: None,
                    })
                }
            }
        }

        Ok(())
    }
}

/// The dataset's time column, where there is exactly one of them.
///
/// Guessing between several would be picking one, and a window on the wrong
/// timestamp returns rows that look right. So the ambiguity is handed back with
/// the candidates in it, which is the shortest path to the caller writing the
/// name they meant.
fn sole_time_column(columns: &[ColumnMeta]) -> Result<String, String> {
    let times: Vec<&str> = columns
        .iter()
        .filter(|c| kind_of(c) == Kind::Time)
        .map(|c| c.name.as_str())
        .collect();

    match times.as_slice() {
        [only] => Ok((*only).to_string()),
        [] => Err(
            "this dataset has no date or timestamp column, so it has no time to \
                   window on"
                .into(),
        ),
        several => Err(format!(
            "this dataset has {} time columns — name the one you mean in `time.column`: {}",
            several.len(),
            several.join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(json: &str) -> Result<Plan, String> {
        serde_json::from_str::<TimeSpec>(json)
            .map_err(|e| e.to_string())?
            .into_plan()
    }

    fn col(name: &str, ty: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            r#type: ty.into(),
        }
    }

    #[test]
    fn last_rolls_and_ends_now() {
        let p = plan(r#"{"last":7,"unit":"days"}"#).expect("a rolling window");
        assert_eq!(
            p.from,
            Some(Edge::Ago {
                unit: Unit::Day,
                count: 7
            })
        );
        // Ends at now, not at the end of today: a rolling window that ran into
        // the future would be a calendar one under the wrong name.
        assert_eq!(p.to, Some(Edge::Now));
    }

    #[test]
    fn a_plural_unit_is_what_anyone_writes() {
        assert_eq!(
            plan(r#"{"last":1,"unit":"day"}"#).unwrap(),
            plan(r#"{"last":1,"unit":"days"}"#).unwrap()
        );
    }

    #[test]
    fn a_period_aligns_to_its_own_boundaries_and_is_half_open() {
        let p = plan(r#"{"period":"previous_month"}"#).expect("a calendar window");
        // The month before this one, from its start to this one's start — so a
        // row exactly at midnight on the first belongs to one month, once.
        assert_eq!(
            p.from,
            Some(Edge::StartOf {
                unit: Unit::Month,
                shift: -1
            })
        );
        assert_eq!(
            p.to,
            Some(Edge::StartOf {
                unit: Unit::Month,
                shift: 0
            })
        );
    }

    #[test]
    fn every_period_names_a_window_one_unit_wide() {
        for (name, _, _) in PERIODS {
            let p = plan(&format!(r#"{{"period":"{name}"}}"#)).expect(name);
            let (Some(Edge::StartOf { shift: from, .. }), Some(Edge::StartOf { shift: to, .. })) =
                (&p.from, &p.to)
            else {
                panic!("{name} is not a calendar window");
            };
            assert_eq!(to - from, 1, "{name} is not one unit wide");
        }
    }

    #[test]
    fn an_exact_window_may_be_open_at_one_end() {
        let p = plan(r#"{"from":"2024-01-01"}"#).expect("everything since");
        assert_eq!(p.from, Some(Edge::Given("2024-01-01".into())));
        assert_eq!(p.to, None);
    }

    #[test]
    fn the_three_kinds_of_window_are_not_mixed() {
        let err = plan(r#"{"last":7,"unit":"days","period":"today"}"#).expect_err("two windows");
        assert!(err.contains("not several at once"), "{err}");

        let err = plan(r#"{"period":"today","from":"2024-01-01"}"#).expect_err("two windows");
        assert!(err.contains("not several at once"), "{err}");
    }

    #[test]
    fn a_unit_left_beside_a_period_is_an_edit_nobody_finished() {
        // Honouring the period and ignoring the unit would hide the mistake.
        let err = plan(r#"{"period":"today","unit":"days"}"#).expect_err("a leftover unit");
        assert!(err.contains("belongs to `last`"), "{err}");
    }

    #[test]
    fn a_window_that_asks_for_nothing_says_so() {
        let err = plan(r#"{"column":"ts"}"#).expect_err("nothing asked");
        assert!(err.contains("asks for nothing"), "{err}");

        let err = plan(r#"{"last":0,"unit":"days"}"#).expect_err("an empty window");
        assert!(err.contains("nothing in it"), "{err}");

        let err = plan(r#"{"last":7}"#).expect_err("no unit");
        assert!(err.contains("needs the `unit`"), "{err}");
    }

    #[test]
    fn a_calendar_comparison_moves_by_whole_units_of_its_own_kind() {
        let p = plan(r#"{"period":"this_month","compare":"previous_period"}"#).unwrap();
        // The month before this one — a month, not thirty days.
        assert_eq!(
            p.compare,
            Some((
                Edge::StartOf {
                    unit: Unit::Month,
                    shift: -1
                },
                Edge::StartOf {
                    unit: Unit::Month,
                    shift: 0
                }
            ))
        );
        // And it lines up exactly with where the current window starts, which
        // is what the label leans on to tell the two apart.
        assert_eq!(p.compare.unwrap().1, p.from.unwrap());
    }

    #[test]
    fn a_rolling_comparison_moves_by_its_own_span() {
        let p = plan(r#"{"last":7,"unit":"days","compare":"previous_period"}"#).unwrap();
        // The seven days before the last seven.
        assert_eq!(
            p.compare,
            Some((
                Edge::Ago {
                    unit: Unit::Day,
                    count: 14
                },
                Edge::Ago {
                    unit: Unit::Day,
                    count: 7
                }
            ))
        );
    }

    #[test]
    fn a_year_back_is_the_same_window_a_year_earlier() {
        let p = plan(r#"{"period":"this_month","compare":"previous_year"}"#).unwrap();
        let (from, to) = p.compare.unwrap();
        // The same month, not the month before — so the shift is untouched and
        // a year comes off both ends.
        assert_eq!(
            from,
            Edge::StartOf {
                unit: Unit::Month,
                shift: 0
            }
            .a_year_before()
        );
        assert_eq!(
            to,
            Edge::StartOf {
                unit: Unit::Month,
                shift: 1
            }
            .a_year_before()
        );
    }

    #[test]
    fn a_window_written_out_by_hand_cannot_be_moved() {
        // Its length is arithmetic on dates, and that is ClickHouse's job here
        // rather than Flint's — so this says so instead of guessing a span.
        let err = plan(r#"{"from":"2024-01-01","to":"2024-02-01","compare":"previous_period"}"#)
            .expect_err("an unmovable window");
        assert!(err.contains("`last` or `period`"), "{err}");
    }

    #[test]
    fn a_comparison_needs_something_to_compare_against() {
        let err =
            plan(r#"{"granularity":"day","compare":"previous_period"}"#).expect_err("no window");
        assert!(err.contains("needs a window"), "{err}");

        let err = plan(r#"{"period":"today","compare":"last_time"}"#).expect_err("no such mode");
        assert!(err.contains("not a comparison"), "{err}");
        assert!(err.contains("previous_year"), "{err}");
    }

    #[test]
    fn the_two_windows_arrive_under_a_label_that_must_be_free() {
        let mut shape = Shape {
            aggregate: Some(Aggregate {
                buckets: Vec::new(),
                dimensions: vec!["window".into()],
                metrics: Vec::new(),
                having: None,
            }),
            ..Default::default()
        };
        let err = plan(r#"{"period":"today","compare":"previous_period"}"#)
            .unwrap()
            .apply(
                &mut shape,
                &[col("ts", "DateTime"), col("window", "String")],
            )
            .expect_err("a collision");
        assert!(err.contains("already called that"), "{err}");
    }

    #[test]
    fn several_times_are_several_windows() {
        // "created in the last week and updated today" is one question with two
        // times in it, and a single `time` object could not hold it — which is
        // how a builder that had always been able to ask it stopped being able
        // to.
        let mut shape = Shape::default();
        for plan in serde_json::from_str::<TimeSpecs>(
            r#"[{"column":"created_at","last":7,"unit":"days"},
                {"column":"updated_at","period":"today"}]"#,
        )
        .expect("two specs")
        .into_plans()
        .expect("two plans")
        {
            plan.apply(
                &mut shape,
                &[col("created_at", "DateTime"), col("updated_at", "DateTime")],
            )
            .expect("applied");
        }
        assert_eq!(shape.windows.len(), 2);
        assert_eq!(shape.windows[0].column, "created_at");
        assert_eq!(shape.windows[1].column, "updated_at");
    }

    #[test]
    fn two_granularities_are_two_columns_in_the_answer() {
        let mut shape = Shape::default();
        for plan in serde_json::from_str::<TimeSpecs>(
            r#"[{"column":"ts","granularity":"day"},{"column":"ts","granularity":"hour"}]"#,
        )
        .unwrap()
        .into_plans()
        .unwrap()
        {
            plan.apply(&mut shape, &[col("ts", "DateTime")])
                .expect("applied");
        }
        let buckets = shape.aggregate.expect("an aggregate").buckets;
        // Same column, two granularities, two distinct names — which is why
        // naming a bucket after its unit was the right call twice over.
        assert_eq!(
            buckets.iter().map(|b| b.alias.as_str()).collect::<Vec<_>>(),
            ["ts_day", "ts_hour"]
        );
    }

    #[test]
    fn one_time_is_still_written_the_way_it_always_was() {
        // The shape almost every request sends, and the one the documentation
        // shows: it must not have become a list to keep working.
        let plans = serde_json::from_str::<TimeSpecs>(r#"{"period":"today"}"#)
            .expect("one spec")
            .into_plans()
            .expect("one plan");
        assert_eq!(plans.len(), 1);
    }

    #[test]
    fn a_comparison_moves_the_window_it_was_put_on() {
        // Not whichever window happens to be first. When it did, a `compare` on
        // the second of two time entries produced an `OR` between the *first*
        // window and the second's previous — two unrelated columns, with the
        // second's own window `AND`ed on top so the previous branch could never
        // match. It returned only the current half, under a label testing the
        // wrong column, and it looked like an answer.
        let mut shape = Shape::default();
        let columns = [col("a", "DateTime"), col("b", "DateTime")];
        for plan in serde_json::from_str::<TimeSpecs>(
            r#"[{"column":"a","period":"today"},
                {"column":"b","period":"this_hour","compare":"previous_period"}]"#,
        )
        .unwrap()
        .into_plans()
        .unwrap()
        {
            plan.apply(&mut shape, &columns).expect("applied");
        }

        let comparison = shape.compare.expect("a comparison");
        // The pair is one column, and it is the column the caller marked.
        assert_eq!(comparison.current.column, "b");
        assert_eq!(comparison.previous.column, "b");
        // And the window that was not compared stays a plain condition, once.
        assert_eq!(shape.windows.len(), 1);
        assert_eq!(shape.windows[0].column, "a");
    }

    #[test]
    fn only_one_window_can_be_the_one_a_comparison_moves() {
        let mut shape = Shape::default();
        let plans = serde_json::from_str::<TimeSpecs>(
            r#"[{"column":"a","period":"today","compare":"previous_period"},
                {"column":"b","period":"today","compare":"previous_period"}]"#,
        )
        .unwrap()
        .into_plans()
        .unwrap();
        let columns = [col("a", "DateTime"), col("b", "DateTime")];
        plans[0]
            .clone()
            .apply(&mut shape, &columns)
            .expect("the first");
        let err = plans[1]
            .clone()
            .apply(&mut shape, &columns)
            .expect_err("the second");
        assert!(err.contains("two answers"), "{err}");
    }

    #[test]
    fn a_granularity_alone_is_still_a_question() {
        let p = plan(r#"{"granularity":"day"}"#).expect("a bucket with no window");
        assert!(p.buckets());

        let mut shape = Shape::default();
        p.apply(&mut shape, &[col("ts", "DateTime")])
            .expect("applied");
        // "Which days are there" is a group by, even with nothing measured.
        let aggregate = shape.aggregate.expect("an aggregate");
        assert_eq!(aggregate.buckets[0].unit, Unit::Day);
        assert!(shape.windows.is_empty());
    }

    #[test]
    fn the_bucket_is_named_for_its_column_and_its_granularity() {
        // Never the column's bare name. An alias that shadows its own source
        // column makes `GROUP BY toStartOfDay(ts)` mean something other than
        // the `toStartOfDay(ts)` that was selected — found by running it, not
        // by reading it.
        let mut shape = Shape::default();
        plan(r#"{"granularity":"month"}"#)
            .unwrap()
            .apply(&mut shape, &[col("ts", "DateTime")])
            .expect("applied");
        let bucket = shape.aggregate.unwrap().buckets.remove(0);
        assert_eq!(bucket.alias, "ts_month");
        assert_eq!(bucket.column, "ts");
    }

    #[test]
    fn a_bucket_that_would_collide_is_refused_like_any_other_name() {
        let mut shape = Shape {
            aggregate: Some(Aggregate {
                buckets: Vec::new(),
                dimensions: vec!["ts_day".into()],
                metrics: Vec::new(),
                having: None,
            }),
            ..Default::default()
        };
        let err = plan(r#"{"granularity":"day"}"#)
            .unwrap()
            .apply(
                &mut shape,
                &[col("ts", "DateTime"), col("ts_day", "String")],
            )
            .expect_err("a collision");
        assert!(err.contains("already is"), "{err}");
    }

    #[test]
    fn the_time_column_is_found_where_there_is_one_of_it() {
        let mut shape = Shape::default();
        plan(r#"{"period":"today"}"#)
            .unwrap()
            .apply(
                &mut shape,
                &[col("city", "String"), col("seen_at", "DateTime64(3)")],
            )
            .expect("applied");
        assert_eq!(shape.windows[0].column, "seen_at");
    }

    #[test]
    fn several_time_columns_are_handed_back_rather_than_chosen_between() {
        // A window on the wrong timestamp returns rows that look right, so
        // picking one is the worst available outcome.
        let mut shape = Shape::default();
        let err = plan(r#"{"period":"today"}"#)
            .unwrap()
            .apply(
                &mut shape,
                &[col("created_at", "DateTime"), col("updated_at", "DateTime")],
            )
            .expect_err("ambiguous");
        assert!(err.contains("2 time columns"), "{err}");
        assert!(err.contains("created_at, updated_at"), "{err}");

        let err = plan(r#"{"period":"today"}"#)
            .unwrap()
            .apply(&mut Shape::default(), &[col("city", "String")])
            .expect_err("no time at all");
        assert!(err.contains("no date or timestamp"), "{err}");
    }

    #[test]
    fn a_named_column_is_taken_as_named() {
        let mut shape = Shape::default();
        plan(r#"{"column":"updated_at","period":"today"}"#)
            .unwrap()
            .apply(
                &mut shape,
                &[col("created_at", "DateTime"), col("updated_at", "DateTime")],
            )
            .expect("applied");
        assert_eq!(shape.windows[0].column, "updated_at");
    }
}
