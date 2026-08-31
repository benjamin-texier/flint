mod alerts;
mod auth;
mod clickhouse;
mod config;
mod dataset;
mod error;
mod export;
mod jobs;
mod published;
mod reports;
mod routes;
mod target;
mod workspace;

use clap::Parser;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("FLINT_LOG")
                .unwrap_or_else(|_| EnvFilter::new("flint=info,tower_http=warn")),
        )
        .with_target(false)
        .init();

    let mut config = config::Config::parse();
    // Before the manifest is read for anything: a variable set to nothing is a
    // variable that is not set, and every check below is entitled to assume it.
    config.normalise();
    let config = config;

    if config.health_check {
        return health_check(&config).await;
    }

    // Before anything is opened: a manifest that contradicts itself should stop
    // here, not serve a UI missing the half somebody asked for.
    config.check()?;

    let mut ch = clickhouse::Client::new(&config)?;

    // Probe once at boot so misconfiguration shows up in the logs rather than
    // as a blank page. A failure is not fatal: ClickHouse may still be starting
    // up alongside us, and the UI reports the problem itself.
    //
    // The two failures are worth telling apart. "Cannot reach it" and "reached
    // it, and it said no" send you looking in completely different places, and
    // reporting the second as the first sends you looking in the wrong one.
    //
    // Only where the manifest names a server. Unpinned there is nothing to
    // probe: the first connection this process makes is the one somebody's
    // sign-in asks for, and the answer to "is it reachable" belongs on that
    // form rather than in a log written before anyone typed an address.
    match config.redacted_endpoint() {
        Some(endpoint) => match clickhouse::meta::server_info(&ch).await {
            Ok(info) => {
                // Kept from the handshake rather than asked again: the dataset
                // API states which zone its dates were cut in on every answer,
                // and a round trip per query to learn a fact that changes only
                // when ClickHouse restarts would be a tax on the busiest path in
                // Flint. Left empty if the handshake could not read it, and the
                // answer then says nothing rather than guessing.
                ch = ch.with_timezone(info.timezone.clone());
                tracing::info!(
                    version = %info.version,
                    databases = info.databases,
                    tables = info.tables,
                    timezone = %info.timezone,
                    readonly = config.readonly,
                    tier = config.tier().as_str(),
                    infrastructure = config.infrastructure,
                    "connected to ClickHouse at {endpoint}"
                );
            }
            Err(e @ error::Error::ClickHouse { .. }) => tracing::warn!(
                "reached ClickHouse at {endpoint} but it refused: {}",
                // ClickHouse appends a multi-paragraph hint to auth errors. The
                // first line is the part that belongs in a log line; the UI shows
                // the rest.
                e.to_string().lines().next().unwrap_or_default()
            ),
            Err(e) => tracing::warn!("{e}"),
        },
        None => {
            tracing::info!(
                tier = config.tier().as_str(),
                infrastructure = config.infrastructure,
                // "Stateless by construction" was the whole of this sentence
                // until the workspace could be given a server of its own, and
                // saying it to a Flint that is about to create ten tables
                // would be the log contradicting itself four lines later.
                // Which half is true now depends on the manifest.
                "unpinned: FLINT_CLICKHOUSE_URL is unset, so the browser names the server at \
                 sign-in.{}",
                if config.workspace_endpoint().is_some() {
                    " The workspace has a server of its own, so what you save is still kept."
                } else {
                    " Stateless by construction — nothing runs on a schedule, because a schedule \
                     has no session to borrow a server from."
                }
            );
            // Said at boot and said loudly, because it is the one thing about
            // this mode an operator cannot see in the UI: without an allow-list,
            // anyone who can reach this port can make this process dial any
            // address it can route to, and learn from the answer whether
            // something is listening there.
            if config.targets.is_empty() {
                tracing::warn!(
                    "unpinned with no allow-list: Flint will dial any host a browser names. Set \
                     FLINT_TARGETS=host[:port],... to narrow it — see src/target.rs for what \
                     that does and does not promise."
                );
            } else {
                tracing::info!(targets = ?config.targets, "unpinned, and only these are allowed");
            }
        }
    }

    // The server Flint keeps its own tables on. Its own where the manifest
    // names one, otherwise the one being explored — which is every deployment
    // that existed before `FLINT_WORKSPACE_URL` did, and still the default.
    //
    // Probed separately when it is separate, and the reason is the whole cost
    // of this feature: with two servers there are two ways to be down, and
    // "workspace not ready" without an address sends an operator to look at the
    // wrong one. Every line below names which server it means.
    let workspace_ch = match clickhouse::Client::for_workspace(&config)? {
        Some(client) => {
            let endpoint = client.endpoint().to_string();
            match clickhouse::meta::server_info(&client).await {
                Ok(info) => {
                    tracing::info!(
                        version = %info.version,
                        timezone = %info.timezone,
                        "workspace server at {endpoint}"
                    );
                    // Its own zone, not the explored server's. Report schedules
                    // are cut against the workspace's clock — `Workspace::clock`
                    // asks this connection — so borrowing the other server's
                    // offset would run the nine o'clock report at nine
                    // somewhere else.
                    client.with_timezone(info.timezone)
                }
                Err(e @ error::Error::ClickHouse { .. }) => {
                    tracing::warn!(
                        "reached the workspace server at {endpoint} but it refused: {} \
                         — check FLINT_WORKSPACE_USER and FLINT_WORKSPACE_PASSWORD, which are \
                         not inherited from the explored server's",
                        e.to_string().lines().next().unwrap_or_default()
                    );
                    client
                }
                // Not fatal, the same bargain as the explored server: it may be
                // starting up alongside us, and `ensure` runs again on first use.
                Err(e) => {
                    tracing::warn!("could not reach the workspace server at {endpoint}: {e}");
                    client
                }
            }
        }
        // No server of its own: Flint's tables go on the server it explores,
        // which is what a workspace has always meant.
        None => ch.clone(),
    };
    if config.workspace_is_separate() && config.workspace_database.is_some() {
        tracing::info!(
            "the workspace is on a server of its own, so Flint creates nothing on the server it \
             explores"
        );
    }

    // Opt-in persistence. Bootstrapped now so a misconfiguration shows up in
    // the log at boot, but not fatal: it is retried on first use, which covers
    // a ClickHouse that is still starting alongside us.
    let workspace = config
        .workspace_database
        .as_ref()
        .map(|db| workspace::Workspace::new(db.clone(), workspace_ch.clone()));
    if let Some(ws) = &workspace {
        match ws.ensure().await {
            Ok(()) => {}
            // The address, because with two servers "not ready" is ambiguous
            // and this is the line somebody reads first.
            Err(e) => tracing::warn!("workspace not ready on {}: {e}", ws.endpoint()),
        }
    } else {
        tracing::info!("stateless: no workspace database configured, nothing will be written");
    }

    // Alerts need somewhere to keep their history, so the scheduler exists
    // only where a workspace does. Spawned before the server starts listening:
    // an alert that fires while nobody has opened the UI is the whole point.
    // Kept as well as spawned: the reports page can ask for a run now, and it
    // must be the same runner the schedule uses — a second implementation of
    // "run a report" is two ways for an edition to be made.
    //
    // A workspace is no longer enough on its own. An alert is a question put to
    // the *explored* server on a timer, and unpinned there is no such server
    // until somebody signs in — the scheduler would tick every minute against
    // an empty URL. So the schedule needs both: somewhere to record what it
    // found, and somewhere to ask. A separate workspace supplies only the first.
    let mut runner = None;
    if let (Some(ws), true) = (workspace.clone(), config.pinned()) {
        let http = clickhouse::webhook_client(
            config.clickhouse_ca_cert.as_deref(),
            std::time::Duration::from_secs(30),
        )?;
        let scheduler = alerts::Scheduler::new(ch.clone(), ws, http, config.alert_webhooks);
        if !config.alert_webhooks {
            tracing::info!("alerts: webhook delivery is off (FLINT_ALERT_WEBHOOKS=false)");
        }
        runner = Some(scheduler.clone());
        tokio::spawn(scheduler.run());
    }

    // Long operations, where there is somewhere to record them. Recovery runs
    // before the server listens: a browser that reconnects should find the job
    // it left already marked interrupted, not a spinner that will never stop.
    //
    // Pinned for the same reason as the scheduler: recovery runs before anybody
    // has signed in, and a job is work done against the explored server.
    let jobs = match (workspace.clone(), config.pinned()) {
        (Some(ws), true) => {
            let runner = jobs::Runner::new(ch.clone(), ws);
            runner.recover().await;
            Some(runner)
        }
        _ => None,
    };

    // Said out loud, because this is the half of the bargain somebody choosing
    // an unpinned workspace has to know about, and the UI cannot show the
    // absence of a scheduler. Saved queries, dashboards and published endpoints
    // all keep working — they are answered by whoever is signed in.
    if workspace.is_some() && !config.pinned() {
        tracing::info!(
            "unpinned with a workspace: what you save is kept, but nothing runs on a schedule — \
             alerts, reports and long jobs all need a server to ask, and unpinned the browser \
             names one only at sign-in. Set FLINT_CLICKHOUSE_URL to turn them on."
        );
    }

    if config.sign_in_required() {
        tracing::info!(
            idle_hours = config.session_idle_hours,
            "sign-in required: statements run as the ClickHouse user who is signed in"
        );
    }
    // Held whatever the setting, and empty when nobody can sign in: one field
    // that is sometimes unused reads better than an Option nothing ever fills.
    let sessions = auth::Sessions::new(std::time::Duration::from_secs(
        config.session_idle_hours.max(1) * 3600,
    ));

    let addr = config.bind_addr();
    let state = routes::AppState {
        ch,
        config: Arc::new(config),
        workspace,
        runner,
        sessions,
        // Bounds how many addresses this process dials at once for callers who
        // are nobody yet. See `AppState::dials`.
        dials: Arc::new(tokio::sync::Semaphore::new(routes::CONCURRENT_DIALS)),
        jobs,
        api_cache: Arc::new(published::cache::Cache::new()),
        calls: Arc::new(published::log::CallLog::new()),
    };

    // The other half of the buffered call log. Started before the listener, so
    // no call can be recorded into a buffer nothing is draining — and only
    // where there is a workspace to drain it into, since without one there is
    // nothing to publish and nothing to record.
    if let Some(workspace) = state.workspace.clone() {
        let calls = state.calls.clone();
        tokio::spawn(async move {
            // A short tick rather than a sleep for the whole flush window: a
            // burst that fills the buffer should be written when it fills,
            // not when the clock next comes round.
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if !calls.due() {
                    continue;
                }
                let (batch, dropped) = calls.take();
                if dropped > 0 {
                    // Said out loud. A usage panel quietly missing an hour is
                    // worse than one that says it is, and this is the only
                    // place that knows.
                    tracing::warn!(
                        dropped,
                        "the call log filled up and dropped calls; \
                         the endpoints page is missing them"
                    );
                }
                let held = batch.len();
                if let Err(e) = workspace.write_calls(&batch).await {
                    calls.give_back(batch);
                    // The backlog after the batch went back, which is the
                    // figure an operator wants: it says whether this is one
                    // failed write or an hour of them, and the buffer has a cap
                    // it will start dropping at.
                    tracing::debug!(
                        held,
                        waiting = calls.waiting(),
                        error = %e,
                        "could not write the call log; will retry"
                    );
                }
            }
        });
    }
    // A raw `Os { code: 98, kind: AddrInUse }` says nothing about what to do.
    // This is the most common way starting Flint fails — another Flint, or the
    // host one clashing with a container on `network_mode: host`.
    let listener = tokio::net::TcpListener::bind(&addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!(
                "{addr} is already in use. Something else is listening there — \
                 another Flint, perhaps. Free it, or set FLINT_PORT to another port."
            )
        } else {
            format!("could not listen on {addr}: {e}")
        }
    })?;
    tracing::info!("Flint is listening on http://{addr}");

    axum::serve(listener, routes::router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// Liveness for a container orchestrator: does this Flint answer?
///
/// Deliberately not a readiness check on ClickHouse. If the database is down,
/// Flint is still doing its job — it says so on the page — and restarting it
/// would fix nothing while making the outage harder to see.
async fn health_check(config: &config::Config) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!("http://127.0.0.1:{}/api/health", config.port);
    let response = clickhouse::http_client(None, std::time::Duration::from_secs(4))?
        .get(&url)
        .send()
        .await
        // The raw reqwest debug dump ends up in `docker inspect`, so say the
        // one thing an operator needs instead.
        .map_err(|_| format!("no Flint answering on port {}", config.port))?;

    if response.status().is_success() {
        println!("serving on port {}", config.port);
        Ok(())
    } else {
        Err(format!("port {} answered {}", config.port, response.status()).into())
    }
}

async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for ctrl-c");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    tracing::info!("shutting down");
}
