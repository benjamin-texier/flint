//! `flint k8s` — a ClickHouse only Kubernetes can route to.
//!
//! The gesture this exists for is the one somebody already makes by hand:
//! `kubectl port-forward`, then paste an address and a password into Flint. It
//! is three commands and a copied secret, and every one of them is a chance to
//! be on the wrong context.
//!
//! Three decisions are worth stating here rather than discovering in the code.
//!
//! **It shells out to `kubectl`.** A kubeconfig is contexts, exec credential
//! plugins, OIDC and three clouds' worth of auth, and a second implementation of
//! it is a second implementation that can disagree with the first — the same
//! argument this codebase makes about parsing `SHOW GRANTS` rather than
//! attempting the read. `kubectl` is already installed on the machine of anyone
//! typing `sts/`, and it is the thing they know how to debug.
//!
//! **It follows references, it does not guess.** Everything below is read out of
//! the pod template or the CHI: `secretKeyRef` names the secret *and* the key, a
//! literal `value:` is the password itself, a CHI declares where its users live.
//! The one place a convention is used — `envFrom`, which imports a whole secret
//! and names no key — says so in the output. Nothing sweeps the namespace
//! looking for a secret whose name contains "clickhouse"; that is the guess this
//! module refuses to make, because a guess that succeeds silently is the kind
//! that gets somebody into the wrong server.
//!
//! **Reading the secret is not an escalation, and this module does not pretend
//! it is.** Anyone holding `get secrets` in that namespace also holds `exec`,
//! and `kubectl exec -it pod -- clickhouse-client` is the same session by a
//! longer road. So the guard is not on the way in. It is on what the session may
//! then *do*: `flint k8s` resolves to the `read` tier unless somebody says
//! otherwise, because being able to be admin and being admin all afternoon are
//! not the same thing, and typing the name of a StatefulSet is not a sentence
//! that asks for `DROP`.

use crate::config::{Config, Tier};
use serde_json::Value;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// How long to wait for `kubectl port-forward` to announce itself. Generous,
/// because the first call on a cold context can be an OIDC round trip through a
/// browser, and killing that at three seconds would be a tool that works only
/// for people already logged in.
const FORWARD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// ClickHouse's HTTP port, used only where the pod declares nothing.
const DEFAULT_HTTP_PORT: u16 = 8123;

#[derive(Debug, Clone, clap::Args)]
pub struct K8s {
    /// What to reach: `sts/name`, `svc/name`, `pod/name` or `chi/name`.
    ///
    /// Spelled the way `kubectl` spells it, deliberately. Somebody typing this
    /// types `kubectl` all day, and a second vocabulary for the same objects is
    /// a thing to learn for no gain.
    pub target: String,

    /// Namespace. Defaults to the context's, exactly as `kubectl` does.
    #[arg(short = 'n', long)]
    pub namespace: Option<String>,

    /// Context. Defaults to the current one.
    #[arg(long)]
    pub context: Option<String>,

    /// Which pod to forward to, where the target names more than one.
    #[arg(long)]
    pub pod: Option<String>,

    /// Which declared ClickHouse user to connect as.
    #[arg(long)]
    pub user: Option<String>,

    /// Where the password is, when nothing in the cluster declares it:
    /// `secret/name#key`.
    #[arg(long)]
    pub password_from: Option<String>,

    /// Open the tunnel and leave the credentials to the sign-in form.
    ///
    /// The shape for a Flint more than one person will use: the tunnel is
    /// shared, the account is not, and `system.query_log` carries the name of
    /// whoever asked rather than the name in a secret.
    #[arg(long, default_value_t = false)]
    pub sign_in: bool,

    /// What this session may do: `read`, `data`, `ddl` or `admin`.
    #[arg(long, value_enum)]
    pub tier: Option<Tier>,

    /// Local port for the tunnel. One is chosen from the ephemeral range where
    /// this is absent.
    #[arg(long)]
    pub local_port: Option<u16>,
}

impl K8s {
    /// The `-n` and `--context` every call repeats.
    fn scope(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(ns) = &self.namespace {
            args.push("-n".into());
            args.push(ns.clone());
        }
        if let Some(context) = &self.context {
            args.push("--context".into());
            args.push(context.clone());
        }
        args
    }
}

/// What the target names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    StatefulSet,
    Service,
    Pod,
    /// A `ClickHouseInstallation`, the Altinity operator's CRD.
    Chi,
}

impl Kind {
    fn resource(self) -> &'static str {
        match self {
            Kind::StatefulSet => "statefulset",
            Kind::Service => "service",
            Kind::Pod => "pod",
            Kind::Chi => "clickhouseinstallation",
        }
    }
}

/// `sts/name` into its two halves.
///
/// A bare name is taken as a StatefulSet and the output says so. `kubectl`
/// refuses a bare name outright, which is right for a tool that addresses forty
/// kinds and wrong for one that addresses a database: here there is an obvious
/// reading, and refusing it would be pedantry with an error message.
pub fn parse_target(target: &str) -> Result<(Kind, String), String> {
    let (kind, name) = match target.split_once('/') {
        Some((kind, name)) => (kind, name),
        None => ("sts", target),
    };
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("`{target}` names no object"));
    }
    let kind = match kind.trim().to_ascii_lowercase().as_str() {
        "sts" | "statefulset" | "statefulsets" => Kind::StatefulSet,
        "svc" | "service" | "services" => Kind::Service,
        "po" | "pod" | "pods" => Kind::Pod,
        "chi" | "clickhouseinstallation" | "clickhouseinstallations" => Kind::Chi,
        other => {
            return Err(format!(
                "`{other}` is not a kind this understands. Use sts/, svc/, pod/ or chi/ — or a \
                 bare name, which is read as a StatefulSet."
            ))
        }
    };
    Ok((kind, name.to_owned()))
}

/// The port to forward to, and why that one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Port {
    pub number: u16,
    pub why: String,
}

/// Which port on the pod speaks HTTP.
///
/// Named `http` wins over the number, because a pod that bothered to name its
/// ports is a pod telling you which is which — and ClickHouse's HTTPS port is
/// 8443 on the same container, so picking by number alone can land on the one
/// that will not talk to us in cleartext.
pub fn http_port(pod_spec: &Value) -> Port {
    let ports: Vec<&Value> = pod_spec
        .get("containers")
        .and_then(Value::as_array)
        .map(|containers| {
            containers
                .iter()
                .filter_map(|c| c.get("ports").and_then(Value::as_array))
                .flatten()
                .collect()
        })
        .unwrap_or_default();

    let number = |p: &Value| p.get("containerPort").and_then(Value::as_u64);

    for port in &ports {
        if port.get("name").and_then(Value::as_str) == Some("http") {
            if let Some(n) = number(port) {
                return Port {
                    number: n as u16,
                    why: "named `http` in the pod spec".into(),
                };
            }
        }
    }
    for port in &ports {
        if number(port) == Some(u64::from(DEFAULT_HTTP_PORT)) {
            return Port {
                number: DEFAULT_HTTP_PORT,
                why: "declared by the container".into(),
            };
        }
    }
    Port {
        number: DEFAULT_HTTP_PORT,
        why: "assumed — the pod declares no HTTP port".into(),
    }
}

/// Where the password is, as the cluster itself declares it.
///
/// Every variant but `Unknown` came out of a manifest. The distinction that
/// matters for the output is between a value this holds and a *reference* it
/// still has to follow: reading the workload and reading the secret are two RBAC
/// verbs, granted separately, and "the devs see workloads but not secrets" is
/// one of the most common splits there is. So a refused secret is not a dead
/// end — the reference is still worth printing, because it names exactly what
/// the person would have to be allowed to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Password {
    /// Written into the pod spec as a literal. Nothing to follow.
    Literal { value: String, env: String },
    /// `env` → `valueFrom.secretKeyRef`: the secret *and* the key.
    SecretKey {
        env: String,
        secret: String,
        key: String,
    },
    /// `envFrom` → `secretRef`: the secret, and no key. The key below is the
    /// convention for the image, and the only assumption in this module.
    SecretEnvFrom { secret: String, key: String },
    /// Declared as a hash. The cluster does not contain the password, it
    /// contains proof of it — and no grant fixes that.
    Hashed { field: String },
    /// The users live in a file mounted from here. Not read: it is XML, and a
    /// third-party XML parser to find one field is a poor trade when the CHI
    /// beside it says the same thing in JSON.
    Mounted { source: String },
    /// Nothing in the manifest says.
    Unknown,
}

/// The user and the password a pod template declares.
///
/// The official and Bitnami images both take `CLICKHOUSE_USER` and
/// `CLICKHOUSE_PASSWORD`, which is what makes this reliable rather than lucky:
/// the container is documenting its own credentials, and the `secretKeyRef`
/// beside it is a pointer we may or may not be allowed to follow.
pub fn declared_in_pod(pod_spec: &Value) -> (Option<String>, Password) {
    let containers = pod_spec
        .get("containers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();

    let mut user = None;
    let mut password = Password::Unknown;

    for container in containers {
        for entry in container
            .get("env")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let literal = entry.get("value").and_then(Value::as_str);
            let secret_ref = entry.pointer("/valueFrom/secretKeyRef");

            match name {
                "CLICKHOUSE_USER" | "CLICKHOUSE_ADMIN_USER" => {
                    if let Some(value) = literal {
                        user = Some(value.to_owned());
                    }
                }
                "CLICKHOUSE_PASSWORD" | "CLICKHOUSE_ADMIN_PASSWORD" => {
                    if let Some(value) = literal {
                        password = Password::Literal {
                            value: value.to_owned(),
                            env: name.to_owned(),
                        };
                    } else if let Some(reference) = secret_ref {
                        let secret = reference
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let key = reference
                            .get("key")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !secret.is_empty() && !key.is_empty() {
                            password = Password::SecretKey {
                                env: name.to_owned(),
                                secret: secret.to_owned(),
                                key: key.to_owned(),
                            };
                        }
                    }
                }
                _ => {}
            }
        }

        // Only where nothing more precise was found: `envFrom` imports a whole
        // secret and names no key, so this is the one place a convention stands
        // in for a declaration — and the output says which key it assumed.
        if password == Password::Unknown {
            for entry in container
                .get("envFrom")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                if let Some(secret) = entry.pointer("/secretRef/name").and_then(Value::as_str) {
                    password = Password::SecretEnvFrom {
                        secret: secret.to_owned(),
                        key: "CLICKHOUSE_PASSWORD".into(),
                    };
                }
            }
        }
    }

    // The operator's shape: no environment at all, the users are in a file
    // mounted under `users.d/`. Worth naming even though it is not read, because
    // "nothing declares a password" and "the password is in that secret, as XML"
    // send somebody to two different places.
    if password == Password::Unknown {
        for volume in pod_spec
            .get("volumes")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let source = volume
                .pointer("/secret/secretName")
                .and_then(Value::as_str)
                .map(|name| format!("secret/{name}"))
                .or_else(|| {
                    volume
                        .pointer("/configMap/name")
                        .and_then(Value::as_str)
                        .map(|name| format!("configmap/{name}"))
                });
            let looks_like_users = volume
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.contains("user") || n.contains("config"));
            if let (Some(source), true) = (source, looks_like_users) {
                password = Password::Mounted { source };
                break;
            }
        }
    }

    (user, password)
}

/// A user the CHI declares, and how it declares its password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChiUser {
    pub name: String,
    pub password: Password,
}

/// The users out of a `ClickHouseInstallation`.
///
/// The operator flattens its user configuration into one map whose keys carry
/// the path — `analyst/password`, `analyst/password_sha256_hex`,
/// `analyst/networks/ip`. So the field is the last segment, and the user is
/// everything before the first slash.
///
/// `k8s_secret_password` and its relatives hold `namespace/name/key` and are the
/// operator's own way of saying "not here, there" — which is exactly the
/// reference this module wants and the reason CHIs are read at all.
pub fn chi_users(chi: &Value) -> Vec<ChiUser> {
    let Some(users) = chi
        .pointer("/spec/configuration/users")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    let mut found: Vec<ChiUser> = Vec::new();
    for (path, value) in users {
        let Some((name, field)) = path.split_once('/') else {
            continue;
        };
        let value = value.as_str().unwrap_or_default().trim();
        let password = match field {
            "password" if !value.is_empty() => Password::Literal {
                value: value.to_owned(),
                env: "the CHI".into(),
            },
            "password_sha256_hex" | "password_double_sha1_hex" => Password::Hashed {
                field: field.to_owned(),
            },
            // `namespace/name/key`, or `name/key` where the namespace is the
            // CHI's own. Only the last two matter here: the tunnel is already
            // scoped to one namespace, and a secret in another is a different
            // conversation.
            "k8s_secret_password" | "k8s_secret_env_name_password" => {
                let parts: Vec<&str> = value.split('/').collect();
                match parts.as_slice() {
                    [.., secret, key] if !secret.is_empty() && !key.is_empty() => {
                        Password::SecretKey {
                            env: "the CHI".into(),
                            secret: (*secret).to_owned(),
                            key: (*key).to_owned(),
                        }
                    }
                    _ => continue,
                }
            }
            _ => continue,
        };

        // A user can declare more than one of these. The first wins and the
        // rest are ignored rather than merged: two declarations of one password
        // is a question for whoever wrote the CHI, not something to resolve
        // silently here.
        if !found.iter().any(|u| u.name == name) {
            found.push(ChiUser {
                name: name.to_owned(),
                password,
            });
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// `secret/name#key`, as `--password-from` spells it.
pub fn parse_password_from(spec: &str) -> Result<(String, String), String> {
    let (source, key) = spec.split_once('#').ok_or_else(|| {
        format!("`{spec}` should be `secret/name#key` — the secret, then the key inside it")
    })?;
    let name = source.strip_prefix("secret/").unwrap_or(source);
    if name.is_empty() || key.is_empty() {
        return Err(format!("`{spec}` names no secret or no key"));
    }
    Ok((name.to_owned(), key.to_owned()))
}

/// The local port out of `Forwarding from 127.0.0.1:49731 -> 8123`.
///
/// This line is both the readiness signal and the answer: `kubectl` prints it
/// once the listener is up, which is the only moment it is true to say the
/// tunnel exists.
pub fn forwarded_port(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("Forwarding from ")?;
    let address = rest.split_whitespace().next()?;
    let port = address.rsplit_once(':')?.1;
    port.parse().ok()
}

/// A running `kubectl port-forward`, and the task that keeps it running.
///
/// Held by `main` for the life of the process. `kill_on_drop` is what makes the
/// tunnel a child rather than an orphan: a Flint that exits leaves no listener
/// behind on a port somebody will bind next week and wonder about.
pub struct Tunnel {
    /// Set when this Flint is the one closing the tunnel.
    ///
    /// Without it, every Ctrl-C ends in an ERROR about a tunnel that "is down",
    /// which is true and useless: the shell signals the whole process group, so
    /// `kubectl` dies at the same moment we do and the supervisor reports our
    /// own shutdown as an outage. A line that fires on every clean exit is a
    /// line nobody reads on the one exit that was not clean.
    closing: Arc<std::sync::atomic::AtomicBool>,
    supervisor: tokio::task::JoinHandle<()>,
}

impl Tunnel {
    /// The flag to set when the shutdown signal arrives, so the supervisor stays
    /// quiet about a death it should have expected.
    pub fn closing(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.closing.clone()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.closing
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // The child is `kill_on_drop`, and the supervisor owns it — so stopping
        // the supervisor is what closes the tunnel.
        self.supervisor.abort();
    }
}

/// Everything the resolution found, before any of it is turned into a config.
struct Resolved {
    pod: String,
    port: Port,
    user: Option<String>,
    password: Password,
}

/// Open the tunnel, read what the cluster declares, and point the config at it.
///
/// Returns the tunnel, which the caller must hold: dropping it closes the port
/// this Flint is about to spend its life talking to.
pub async fn connect(config: &mut Config, args: &K8s) -> Result<Tunnel, String> {
    let (kind, name) = parse_target(&args.target)?;

    // The context and the namespace, first and loudly. The failure this command
    // makes most likely is not a wrong password — it is the right command in
    // the wrong context, and a line nobody read is the only thing between
    // somebody and a production server they meant to leave alone.
    let context = current_context(args).await;
    let namespace = match &args.namespace {
        Some(ns) => ns.clone(),
        None => current_namespace(args).await,
    };
    println!("context {context}, namespace {namespace}");

    let resolved = resolve(args, kind, &name).await?;
    println!("port {} ({})", resolved.port.number, resolved.port.why);

    // Credentials before the tunnel, so a refusal is reported while the output
    // still reads as one story. The tunnel opens either way — a Flint pointed at
    // a server whose password you must type is still a Flint, and it is a much
    // shorter walk than closing this and starting again.
    let credentials = if args.sign_in {
        println!("credentials: --sign-in, so the form asks");
        None
    } else {
        resolve_password(args, &resolved).await
    };

    let local = match args.local_port {
        Some(port) => port,
        None => free_port()?,
    };
    let forward = spawn_forward(args, &resolved.pod, local, resolved.port.number).await?;
    println!("tunnel up on 127.0.0.1:{}", forward.port);

    config.clickhouse_url = Some(format!("http://127.0.0.1:{}", forward.port));
    // Pinned, so nothing consults this. Set anyway because it is the honest
    // statement of what this process is now allowed to dial, and it costs one
    // line to be true rather than merely unused.
    config.targets = vec![format!("127.0.0.1:{}", forward.port)];

    match credentials {
        Some((user, password)) => {
            config.clickhouse_user = user;
            config.clickhouse_password = password;
        }
        // No password, so somebody has to type one. Signing in is how, and
        // connecting as `default` with an empty password first would fail in a
        // way that reads as the tunnel's fault.
        None => config.auth = true,
    }

    // `read` unless somebody said otherwise — see the note at the top of this
    // file. An explicit `--tier`, or a `FLINT_TIER` already in the environment,
    // is somebody saying otherwise; the absence of both is not.
    let tier = args.tier.or(config.tier).unwrap_or(Tier::Read);
    config.tier = Some(tier);
    if tier == Tier::Read {
        // The tier gates Flint; `readonly=2` gates the server. Both, because the
        // promise this command makes on the way in is worth keeping even if a
        // route forgets to check the tier.
        config.readonly = true;
        println!("read-only (--tier data|ddl|admin to widen)");
    } else {
        println!("tier {} (asked for)", tier.as_str());
    }

    let closing = Arc::new(std::sync::atomic::AtomicBool::new(false));
    Ok(Tunnel {
        supervisor: supervise(
            args.clone(),
            resolved.pod,
            forward,
            local,
            resolved.port.number,
            closing.clone(),
        ),
        closing,
    })
}

/// Which pod, and what the workload declares about its users.
async fn resolve(args: &K8s, kind: Kind, name: &str) -> Result<Resolved, String> {
    if kind == Kind::Pod {
        let pod = kubectl_json(args, &["get", "pod", name]).await?;
        let spec = pod.get("spec").cloned().unwrap_or(Value::Null);
        let (user, password) = declared_in_pod(&spec);
        println!("pod/{name}");
        return Ok(Resolved {
            pod: name.to_owned(),
            port: http_port(&spec),
            user,
            password,
        });
    }

    let object = kubectl_json(args, &["get", kind.resource(), name]).await?;
    let selector = label_selector(&object, kind, name)?;
    let pods = kubectl_json(args, &["get", "pods", "-l", &selector]).await?;
    let names: Vec<String> = pods
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|p| p.pointer("/metadata/name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();

    if names.is_empty() {
        return Err(format!(
            "{}/{name} matches no pods (selector {selector})",
            kind.resource()
        ));
    }

    let pod = match &args.pod {
        Some(asked) => {
            if !names.iter().any(|n| n == asked) {
                return Err(format!(
                    "pod {asked} is not one of this {}'s: {}",
                    kind.resource(),
                    names.join(", ")
                ));
            }
            asked.clone()
        }
        None => names[0].clone(),
    };

    // Said whenever there is more than one, because a port-forward reaches
    // exactly one pod and almost everything Flint shows is per-node:
    // `system.query_log`, `system.parts`, the merges, the whole diagnose page.
    // A reading labelled "the server" that is really one replica of three is the
    // kind of wrong that looks right.
    if names.len() > 1 {
        println!(
            "{}/{name} → {} pods, forwarding to {pod} (--pod for another)",
            kind.resource(),
            names.len()
        );
    } else {
        println!("{}/{name} → {pod}", kind.resource());
    }

    // The spec comes from the pod rather than the workload: a CHI's StatefulSet
    // is generated, and what actually runs is the thing to read.
    let spec = kubectl_json(args, &["get", "pod", &pod])
        .await?
        .get("spec")
        .cloned()
        .unwrap_or(Value::Null);
    let port = http_port(&spec);
    let (mut user, mut password) = declared_in_pod(&spec);

    // The operator declares its users in the CHI, not in the environment. Read
    // it where the target is one, or where the workload says it belongs to one —
    // reading the CRD is the most this should ever do, and it is enough.
    if matches!(password, Password::Unknown | Password::Mounted { .. }) {
        let chi = if kind == Kind::Chi {
            Some(name.to_owned())
        } else {
            owning_chi(&object)
        };
        if let Some(chi) = chi {
            if let Ok(installation) = kubectl_json(args, &["get", "chi", &chi]).await {
                let users = chi_users(&installation);
                let chosen = match &args.user {
                    Some(wanted) => users.iter().find(|u| &u.name == wanted).cloned(),
                    // Not a choice this makes for somebody where the CHI
                    // declares several: naming one at random and connecting as
                    // it is precisely the silent guess this module refuses.
                    None if users.len() == 1 => users.first().cloned(),
                    None => {
                        if users.len() > 1 {
                            println!(
                                "chi/{chi} declares {} users ({}) — --user to pick one",
                                users.len(),
                                users
                                    .iter()
                                    .map(|u| u.name.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            );
                        }
                        None
                    }
                };
                if let Some(chosen) = chosen {
                    user = Some(chosen.name);
                    password = chosen.password;
                }
            }
        }
    }

    if let Some(asked) = &args.user {
        user = Some(asked.clone());
    }

    Ok(Resolved {
        pod,
        port,
        user,
        password,
    })
}

/// The label selector that finds a workload's pods.
fn label_selector(object: &Value, kind: Kind, name: &str) -> Result<String, String> {
    let labels = match kind {
        Kind::StatefulSet => object.pointer("/spec/selector/matchLabels"),
        Kind::Service => object.pointer("/spec/selector"),
        // The operator's own label, which is how its pods are found without
        // walking the StatefulSets it generated.
        Kind::Chi => {
            return Ok(format!("clickhouse.altinity.com/chi={name}"));
        }
        Kind::Pod => return Err("a pod is not selected by labels".into()),
    };
    let labels = labels.and_then(Value::as_object).ok_or_else(|| {
        format!(
            "{}/{name} selects no pods — it has no selector",
            kind.resource()
        )
    })?;
    Ok(labels
        .iter()
        .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
        .collect::<Vec<_>>()
        .join(","))
}

/// The CHI a workload belongs to, from its owner references.
fn owning_chi(object: &Value) -> Option<String> {
    object
        .pointer("/metadata/ownerReferences")
        .and_then(Value::as_array)?
        .iter()
        .find(|owner| owner.get("kind").and_then(Value::as_str) == Some("ClickHouseInstallation"))
        .and_then(|owner| owner.get("name").and_then(Value::as_str))
        .map(str::to_owned)
}

/// The user and password to connect with, and the sentence that says where they
/// came from.
///
/// Returns `None` for every case that ends at the sign-in form, having first
/// said *which* case it was: a hash is not a refusal, a refusal is not an
/// absence, and all three used to look identical from the outside.
async fn resolve_password(args: &K8s, resolved: &Resolved) -> Option<(String, String)> {
    let user = resolved
        .user
        .clone()
        .or_else(|| args.user.clone())
        .unwrap_or_else(|| "default".into());

    // An explicit `--password-from` outranks anything the cluster declares. It
    // is somebody who knows where the password is telling us, and this module
    // has no better source than that.
    if let Some(spec) = &args.password_from {
        return match parse_password_from(spec) {
            Ok((secret, key)) => {
                match read_secret(args, &secret, &key).await {
                    Ok(password) => {
                        println!("user `{user}`, password from secret/{secret} key `{key}` (--password-from)");
                        Some((user, password))
                    }
                    Err(why) => {
                        println!("user `{user}`, and secret/{secret} key `{key}` could not be read: {why}");
                        None
                    }
                }
            }
            Err(why) => {
                println!("{why}");
                None
            }
        };
    }

    match &resolved.password {
        Password::Literal { value, env } => {
            println!("user `{user}`, password written into the manifest ({env})");
            Some((user, value.clone()))
        }
        Password::SecretKey { env, secret, key } => {
            match read_secret(args, secret, key).await {
                Ok(password) => {
                    println!(
                        "user `{user}`, password from secret/{secret} key `{key}`\n  \
                         (declared by {env} — --sign-in to ignore it)"
                    );
                    Some((user, password))
                }
                Err(why) => {
                    // The reference is printed even though the read failed, and
                    // that is the whole point of following references rather
                    // than sweeping: this line names the exact secret and key
                    // somebody would have to be granted.
                    println!(
                        "user `{user}`, password in secret/{secret} key `{key}` — {why}\n  \
                         sign in on the form, or --password-from"
                    );
                    None
                }
            }
        }
        Password::SecretEnvFrom { secret, key } => match read_secret(args, secret, key).await {
            Ok(password) => {
                println!(
                    "user `{user}`, password from secret/{secret} key `{key}`\n  \
                         (the container imports the whole secret, so the key is the image's \
                         convention rather than a declaration)"
                );
                Some((user, password))
            }
            Err(why) => {
                println!("user `{user}`, secret/{secret} key `{key}`: {why}");
                None
            }
        },
        Password::Hashed { field } => {
            println!(
                "user `{user}` is declared by {field} — the cluster holds the hash, not the \
                 password, and no grant changes that\n  sign in on the form"
            );
            None
        }
        Password::Mounted { source } => {
            println!(
                "the users are in a file mounted from {source}, which this does not read\n  \
                 sign in on the form, or --password-from"
            );
            None
        }
        Password::Unknown => {
            println!("nothing in the manifest declares a password — sign in on the form");
            None
        }
    }
}

/// One key out of one secret.
///
/// `go-template` rather than `jsonpath` because the value is base64 and
/// `base64decode` is a function `kubectl` already carries — a base64 dependency
/// in this tree to decode one field would be a crate for a line.
async fn read_secret(args: &K8s, secret: &str, key: &str) -> Result<String, String> {
    // Asked first so the failure names the verb rather than quoting an API
    // server. It is the same courtesy the sign-in screen does for a missing
    // GRANT: what you would have to be allowed to do, not that you were refused.
    if !can_i(args, "get", "secrets").await {
        return Err(
            "your RBAC does not let you read secrets here (kubectl auth can-i get secrets → no)"
                .into(),
        );
    }
    let template = format!("{{{{ index .data \"{key}\" | base64decode }}}}");
    let output = kubectl(
        args,
        &[
            "get",
            "secret",
            secret,
            "-o",
            &format!("go-template={template}"),
        ],
    )
    .await?;
    let value = String::from_utf8_lossy(&output)
        .trim_end_matches('\n')
        .to_owned();
    if value.is_empty() || value.contains("<no value>") {
        return Err(format!("secret/{secret} has no key `{key}`"));
    }
    Ok(value)
}

async fn can_i(args: &K8s, verb: &str, resource: &str) -> bool {
    kubectl(args, &["auth", "can-i", verb, resource])
        .await
        .map(|out| String::from_utf8_lossy(&out).trim() == "yes")
        .unwrap_or(false)
}

async fn current_context(args: &K8s) -> String {
    if let Some(context) = &args.context {
        return context.clone();
    }
    kubectl(args, &["config", "current-context"])
        .await
        .map(|out| String::from_utf8_lossy(&out).trim().to_owned())
        .unwrap_or_else(|_| "unknown".into())
}

async fn current_namespace(args: &K8s) -> String {
    kubectl(
        args,
        &["config", "view", "--minify", "-o", "jsonpath={..namespace}"],
    )
    .await
    .map(|out| String::from_utf8_lossy(&out).trim().to_owned())
    .ok()
    .filter(|ns| !ns.is_empty())
    .unwrap_or_else(|| "default".into())
}

/// `kubectl`, with the scope every call repeats, and its stderr as the error.
async fn kubectl(args: &K8s, call: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("kubectl")
        .args(call)
        .args(args.scope())
        .output()
        .await
        .map_err(|e| match e.kind() {
            // The one failure worth its own sentence: this whole command is a
            // wrapper around a binary, and "not found" is the only error where
            // the fix has nothing to do with Kubernetes.
            std::io::ErrorKind::NotFound => {
                "kubectl is not on the PATH, and `flint k8s` is a wrapper around it".to_owned()
            }
            _ => format!("could not run kubectl: {e}"),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("kubectl failed and said nothing");
        return Err(first.trim().trim_start_matches("error: ").to_owned());
    }
    Ok(output.stdout)
}

async fn kubectl_json(args: &K8s, call: &[&str]) -> Result<Value, String> {
    let mut call = call.to_vec();
    call.push("-o");
    call.push("json");
    let out = kubectl(args, &call).await?;
    serde_json::from_slice(&out).map_err(|e| format!("could not read what kubectl answered: {e}"))
}

/// A free port, chosen here rather than by `kubectl`.
///
/// `kubectl port-forward :8123` would pick one and print it, which is simpler
/// until the tunnel drops: reopening on the same local port is what lets a Flint
/// already pointed at 127.0.0.1:49731 keep working, and that requires knowing
/// the number before the first spawn rather than after it.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not find a free local port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not find a free local port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

struct Forward {
    child: Child,
    port: u16,
}

/// Start `kubectl port-forward` and wait until it says it is listening.
async fn spawn_forward(args: &K8s, pod: &str, local: u16, remote: u16) -> Result<Forward, String> {
    let mut child = Command::new("kubectl")
        .arg("port-forward")
        .args(args.scope())
        .arg(format!("pod/{pod}"))
        .arg(format!("{local}:{remote}"))
        .arg("--address")
        .arg("127.0.0.1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A Flint that exits should not leave a listener behind on a port
        // somebody binds next week and wonders about.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                "kubectl is not on the PATH, and `flint k8s` is a wrapper around it".to_owned()
            }
            _ => format!("could not run kubectl port-forward: {e}"),
        })?;

    // Collected from the start rather than read on failure: `kubectl` explains
    // itself on stderr and then exits, and a pipe nobody drained is an
    // explanation nobody has.
    let complaints: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let complaints = complaints.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "flint::k8s", "kubectl: {line}");
                if let Ok(mut held) = complaints.lock() {
                    held.push(line);
                }
            }
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "kubectl port-forward has no stdout".to_owned())?;
    let mut lines = BufReader::new(stdout).lines();

    let announced = tokio::time::timeout(FORWARD_TIMEOUT, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(port) = forwarded_port(&line) {
                return Some(port);
            }
        }
        None
    })
    .await;

    // Kept draining after the announcement. A full pipe stops `kubectl` writing,
    // and a port-forward that cannot log is a port-forward that stops.
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(target: "flint::k8s", "kubectl: {line}");
        }
    });

    match announced {
        Ok(Some(port)) => Ok(Forward { child, port }),
        other => {
            let said = complaints
                .lock()
                .ok()
                .map(|held| held.join("; "))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| match other {
                    Err(_) => format!("it said nothing for {}s", FORWARD_TIMEOUT.as_secs()),
                    _ => "it exited without opening one".into(),
                });
            Err(format!("could not open a tunnel to {pod}: {said}"))
        }
    }
}

/// Keep the tunnel open, and name it when it is not.
///
/// The fourth way an address fails. Flint already tells apart "nothing is
/// listening", "ClickHouse said no" and "something answered and it is not
/// ClickHouse" — a tunnel that dies would be reported as the first, which sends
/// somebody to look at a database that is perfectly fine. So it is said here,
/// with the pod's name in it, by the only thing that knows.
fn supervise(
    args: K8s,
    pod: String,
    forward: Forward,
    local: u16,
    remote: u16,
    closing: Arc<std::sync::atomic::AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    let Forward { mut child, port } = forward;
    tokio::spawn(async move {
        let mut backoff = std::time::Duration::from_secs(1);
        loop {
            let status = child.wait().await;
            if closing.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            match status {
                Ok(status) => tracing::error!(
                    "the tunnel to {pod} is down (kubectl port-forward exited {status}) — \
                     reopening on 127.0.0.1:{port}"
                ),
                Err(e) => tracing::error!("lost track of the tunnel to {pod}: {e} — reopening"),
            }
            tokio::time::sleep(backoff).await;
            // Capped rather than unbounded: a pod that is being rescheduled
            // comes back in a minute, and an hour-long backoff would outlast the
            // outage it was waiting on.
            backoff = (backoff * 2).min(std::time::Duration::from_secs(30));
            match spawn_forward(&args, &pod, local, remote).await {
                Ok(reopened) => {
                    tracing::info!("tunnel to {pod} reopened on 127.0.0.1:{}", reopened.port);
                    backoff = std::time::Duration::from_secs(1);
                    child = reopened.child;
                }
                Err(why) => {
                    tracing::warn!("could not reopen the tunnel to {pod}: {why}");
                    // Nothing to wait on, so the loop would spin. A dead child
                    // that is already reaped returns immediately from `wait`,
                    // so the sleep above is the only thing pacing this — and it
                    // is, because `child` is unchanged and still reaped.
                    continue;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_bare_name_is_a_statefulset() {
        assert_eq!(
            parse_target("clickhouse-clickhouse").unwrap(),
            (Kind::StatefulSet, "clickhouse-clickhouse".to_owned())
        );
        assert_eq!(
            parse_target("sts/clickhouse-clickhouse").unwrap(),
            (Kind::StatefulSet, "clickhouse-clickhouse".to_owned())
        );
        assert_eq!(
            parse_target("chi/clickhouse").unwrap(),
            (Kind::Chi, "clickhouse".to_owned())
        );
        assert!(parse_target("deploy/clickhouse").is_err());
        assert!(parse_target("sts/").is_err());
    }

    #[test]
    fn a_named_http_port_beats_the_number() {
        // 8443 first and named, 8123 present: the name is what the pod is
        // telling us, and picking by number would land on the port that will
        // not speak cleartext.
        let spec = json!({
            "containers": [{
                "ports": [
                    {"name": "https", "containerPort": 8443},
                    {"name": "http", "containerPort": 9000}
                ]
            }]
        });
        assert_eq!(http_port(&spec).number, 9000);
    }

    #[test]
    fn a_pod_that_declares_no_port_gets_the_default_and_is_told_so() {
        let port = http_port(&json!({"containers": [{}]}));
        assert_eq!(port.number, 8123);
        assert!(port.why.contains("assumed"), "{}", port.why);
    }

    #[test]
    fn a_secret_key_ref_names_the_secret_and_the_key() {
        let spec = json!({
            "containers": [{
                "env": [
                    {"name": "CLICKHOUSE_USER", "value": "analyst"},
                    {"name": "CLICKHOUSE_PASSWORD", "valueFrom": {
                        "secretKeyRef": {"name": "clickhouse-creds", "key": "password"}
                    }}
                ]
            }]
        });
        let (user, password) = declared_in_pod(&spec);
        assert_eq!(user.as_deref(), Some("analyst"));
        assert_eq!(
            password,
            Password::SecretKey {
                env: "CLICKHOUSE_PASSWORD".into(),
                secret: "clickhouse-creds".into(),
                key: "password".into(),
            }
        );
    }

    #[test]
    fn a_literal_password_is_read_from_the_manifest_itself() {
        let spec = json!({
            "containers": [{"env": [{"name": "CLICKHOUSE_PASSWORD", "value": "hunter2"}]}]
        });
        let (_, password) = declared_in_pod(&spec);
        assert_eq!(
            password,
            Password::Literal {
                value: "hunter2".into(),
                env: "CLICKHOUSE_PASSWORD".into()
            }
        );
    }

    #[test]
    fn env_from_names_a_secret_and_no_key() {
        // The one assumption in the module, and it must stay visible as its own
        // variant rather than being flattened into `SecretKey` — the output
        // says the key was a convention, and it can only say that if the type
        // remembers.
        let spec = json!({
            "containers": [{"envFrom": [{"secretRef": {"name": "clickhouse-creds"}}]}]
        });
        let (_, password) = declared_in_pod(&spec);
        assert_eq!(
            password,
            Password::SecretEnvFrom {
                secret: "clickhouse-creds".into(),
                key: "CLICKHOUSE_PASSWORD".into()
            }
        );
    }

    #[test]
    fn a_precise_reference_beats_a_whole_secret() {
        let spec = json!({
            "containers": [{
                "env": [{"name": "CLICKHOUSE_PASSWORD", "valueFrom": {
                    "secretKeyRef": {"name": "precise", "key": "password"}
                }}],
                "envFrom": [{"secretRef": {"name": "vague"}}]
            }]
        });
        let (_, password) = declared_in_pod(&spec);
        assert!(matches!(password, Password::SecretKey { secret, .. } if secret == "precise"));
    }

    #[test]
    fn a_mounted_config_is_named_rather_than_read() {
        let spec = json!({
            "containers": [{}],
            "volumes": [{"name": "chi-clickhouse-users", "secret": {"secretName": "chi-clickhouse-users"}}]
        });
        let (_, password) = declared_in_pod(&spec);
        assert_eq!(
            password,
            Password::Mounted {
                source: "secret/chi-clickhouse-users".into()
            }
        );
    }

    #[test]
    fn a_chi_declares_users_by_the_last_segment_of_the_key() {
        let chi = json!({"spec": {"configuration": {"users": {
            "analyst/password_sha256_hex": "8d969ee6",
            "analyst/networks/ip": "::/0",
            "loader/k8s_secret_password": "clickhouse/loader-creds/password",
            "guest/password": "guest"
        }}}});
        let users = chi_users(&chi);
        assert_eq!(users.len(), 3);
        assert_eq!(users[0].name, "analyst");
        assert!(matches!(users[0].password, Password::Hashed { .. }));
        assert_eq!(users[1].name, "guest");
        assert_eq!(
            users[2].password,
            Password::SecretKey {
                env: "the CHI".into(),
                secret: "loader-creds".into(),
                key: "password".into()
            }
        );
    }

    #[test]
    fn a_chi_with_no_users_is_empty_rather_than_an_error() {
        assert!(chi_users(&json!({"spec": {}})).is_empty());
    }

    #[test]
    fn the_forwarding_line_is_the_readiness_signal() {
        assert_eq!(
            forwarded_port("Forwarding from 127.0.0.1:49731 -> 8123"),
            Some(49731)
        );
        assert_eq!(
            forwarded_port("Forwarding from [::1]:49731 -> 8123"),
            Some(49731)
        );
        assert_eq!(forwarded_port("Handling connection for 49731"), None);
        assert_eq!(forwarded_port(""), None);
    }

    #[test]
    fn password_from_wants_a_secret_and_a_key() {
        assert_eq!(
            parse_password_from("secret/clickhouse-creds#password").unwrap(),
            ("clickhouse-creds".to_owned(), "password".to_owned())
        );
        assert_eq!(
            parse_password_from("clickhouse-creds#password").unwrap(),
            ("clickhouse-creds".to_owned(), "password".to_owned())
        );
        assert!(parse_password_from("clickhouse-creds").is_err());
        assert!(parse_password_from("clickhouse-creds#").is_err());
    }

    #[test]
    fn a_statefulset_is_selected_by_its_match_labels() {
        let sts = json!({"spec": {"selector": {"matchLabels": {"app": "clickhouse"}}}});
        assert_eq!(
            label_selector(&sts, Kind::StatefulSet, "clickhouse").unwrap(),
            "app=clickhouse"
        );
    }

    #[test]
    fn a_workload_the_operator_made_names_its_chi() {
        let sts = json!({"metadata": {"ownerReferences": [
            {"kind": "ClickHouseInstallation", "name": "clickhouse"}
        ]}});
        assert_eq!(owning_chi(&sts).as_deref(), Some("clickhouse"));
        assert_eq!(owning_chi(&json!({"metadata": {}})), None);
    }
}
