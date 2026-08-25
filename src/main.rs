mod alerts;
mod clickhouse;
mod config;
mod error;
mod published;
mod reports;
mod routes;
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

    let config = config::Config::parse();

    if config.health_check {
        return health_check(&config).await;
    }

    // Before anything is opened: a manifest that contradicts itself should stop
    // here, not serve a UI missing the half somebody asked for.
    config.check()?;

    let ch = clickhouse::Client::new(&config)?;

    // Probe once at boot so misconfiguration shows up in the logs rather than
    // as a blank page. A failure is not fatal: ClickHouse may still be starting
    // up alongside us, and the UI reports the problem itself.
    //
    // The two failures are worth telling apart. "Cannot reach it" and "reached
    // it, and it said no" send you looking in completely different places, and
    // reporting the second as the first sends you looking in the wrong one.
    match clickhouse::meta::server_info(&ch).await {
        Ok(info) => tracing::info!(
            version = %info.version,
            databases = info.databases,
            tables = info.tables,
            readonly = config.readonly,
            tier = config.tier().as_str(),
            infrastructure = config.infrastructure,
            "connected to ClickHouse at {}",
            config.redacted_endpoint()
        ),
        Err(e @ error::Error::ClickHouse { .. }) => tracing::warn!(
            "reached ClickHouse at {} but it refused: {}",
            config.redacted_endpoint(),
            // ClickHouse appends a multi-paragraph hint to auth errors. The
            // first line is the part that belongs in a log line; the UI shows
            // the rest.
            e.to_string().lines().next().unwrap_or_default()
        ),
        Err(e) => tracing::warn!("{e}"),
    }

    // Opt-in persistence. Bootstrapped now so a misconfiguration shows up in
    // the log at boot, but not fatal: it is retried on first use, which covers
    // a ClickHouse that is still starting alongside us.
    let workspace = config
        .workspace_database
        .as_ref()
        .map(|db| workspace::Workspace::new(db.clone()));
    if let Some(ws) = &workspace {
        match ws.ensure(&ch).await {
            Ok(()) => {}
            Err(e) => tracing::warn!("workspace not ready: {e}"),
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
    let mut runner = None;
    if let Some(ws) = workspace.clone() {
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

    let addr = config.bind_addr();
    let state = routes::AppState {
        ch,
        config: Arc::new(config),
        workspace,
        runner,
    };
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
