//! Linear, Jira Cloud and ClickUp from the app (X44, ADR 0010): tokens from
//! the Keychain, requests with reqwest, answers read by `moonlet-trackers`.
//! The daemon never sees a token.

use moonlet_trackers::config::{Connection, TrackersConfig, connection_id};
use moonlet_trackers::states::Column;
use moonlet_trackers::task::TrackerTask;
use moonlet_trackers::config::{BoardColumn, Finished, Origin};
use moonlet_trackers::board::{BoardIssue, Sprint};
use moonlet_trackers::jira_board::{self, BoardSetup, JiraBoard, SearchFields};
use moonlet_trackers::{ApiError, TrackerKind, clickup, jira, linear};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::secrets;

/// What the app gets when a request fails; `auth` asks to reconnect.
#[derive(Debug, Serialize)]
pub struct TrackerError {
    pub auth: bool,
    pub message: String,
}

impl From<ApiError> for TrackerError {
    fn from(e: ApiError) -> Self {
        Self { auth: e.auth, message: e.message }
    }
}

fn fail(message: impl std::fmt::Display) -> TrackerError {
    TrackerError { auth: false, message: message.to_string() }
}

type Res<T> = Result<T, TrackerError>;

/// A Jira Cloud host as the user typed it, or why it can't be one. Only such
/// a host ever receives the Jira token.
fn jira_site(input: &str) -> Res<String> {
    let site = input.trim().trim_start_matches("https://").trim_end_matches('/').to_ascii_lowercase();
    let plain = !site.is_empty() && site.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let label = site.strip_suffix(".atlassian.net").or_else(|| site.strip_suffix(".jira.com"));
    match label {
        Some(l) if plain && !l.is_empty() && !l.starts_with('.') && !l.contains("..") => Ok(site),
        _ => Err(fail(format!("{} is not a Jira Cloud site, such as acme.atlassian.net", input.trim()))),
    }
}

/// An issue, list or team id that goes into a URL path: letters, digits, `-` and `_` only.
fn safe_id(id: &str) -> Res<&str> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err(fail(format!("unexpected id from the tracker: {id}")))
    }
}

/// The API base of a tracker. Only an e2e build can point trackers at a mock
/// server, so no environment variable can send a token elsewhere.
fn base(kind: TrackerKind, site: &str) -> String {
    #[cfg(feature = "e2e")]
    if let Ok(mock) = std::env::var("MOONLET_TRACKER_BASE") {
        let name = match kind {
            TrackerKind::Linear => "linear",
            TrackerKind::Jira => "jira",
            TrackerKind::Clickup => "clickup",
            TrackerKind::Github => "github",
        };
        return format!("{}/{name}", mock.trim_end_matches('/'));
    }
    match kind {
        TrackerKind::Linear => linear::API.trim_end_matches("/graphql").to_string(),
        TrackerKind::Jira => format!("https://{site}"),
        TrackerKind::Clickup => clickup::API.to_string(),
        TrackerKind::Github => String::new(),
    }
}

fn client() -> Res<reqwest::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .user_agent(concat!("moonlet/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(fail)
}

/// The status and body of a request. Network errors are never auth errors.
async fn send(req: reqwest::RequestBuilder) -> Res<(u16, Vec<u8>)> {
    let r = req.send().await.map_err(|e| fail(format!("cannot reach the tracker: {e}")))?;
    let status = r.status().as_u16();
    let body = r.bytes().await.map_err(fail)?.to_vec();
    Ok((status, body))
}

/// A signed-in tracker: its connection and token.
struct Session {
    conn: Connection,
    token: String,
}

impl Session {
    async fn load(id: &str) -> Res<Self> {
        let config = crate::read_trackers(&crate::trackers_path()).map_err(fail)?;
        let conn = config.connections.into_iter().find(|c| c.id == id).ok_or_else(|| fail(format!("no connection {id}")))?;
        let again = sign_in_again;
        let missing = || TrackerError { auth: true, message: format!("No saved token for {}; reconnect it", conn.site) };
        let secret = secrets::store().get(id).ok_or_else(missing)?;
        if conn.auth != "oauth" {
            return Ok(Self { conn, token: secret });
        }
        // OAuth: the access token, refreshed shortly before it expires.
        let read = || serde_json::from_str::<moonlet_trackers::oauth::Tokens>(&secrets::store().get(id).ok_or_else(again)?).map_err(|_| again());
        let save = |t: &moonlet_trackers::oauth::Tokens| secrets::store().set(id, &serde_json::to_string(t).map_err(fail)?).map_err(fail);
        let refresh = |refresh: String| async move {
            let Some(client_id) = LINEAR_CLIENT_ID else { return Err(again()) };
            let (status, body) = send(
                client()?
                    .post(linear::TOKEN)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .body(moonlet_trackers::oauth::refresh_body(client_id, &refresh)),
            )
            .await?;
            if !(200..300).contains(&status) {
                return Err(again());
            }
            Ok(moonlet_trackers::oauth::parse_tokens(&body, moonlet_core::paths::now_ms())?)
        };
        let token = fresh_access(read, save, moonlet_core::paths::now_ms, refresh).await?;
        Ok(Self { conn, token })
    }

    async fn linear(&self, query: &str, variables: Value) -> Res<Vec<u8>> {
        linear_request(&self.token, &self.conn.auth, query, variables).await
    }

    /// A Linear parse result, with a rejected OAuth sign-in worded as such.
    fn linear_ok<T>(&self, r: Result<T, ApiError>) -> Res<T> {
        r.map_err(|e| linear_error(e, &self.conn.auth))
    }

    fn jira(&self, method: reqwest::Method, path: &str) -> Res<reqwest::RequestBuilder> {
        let (email, token) = self.token.split_once(':').ok_or_else(|| fail("the saved Jira token is broken; reconnect"))?;
        // The site comes from trackers.toml, which can be edited: check it again.
        let site = jira_site(&self.conn.site)?;
        Ok(client()?
            .request(method, format!("{}{path}", base(TrackerKind::Jira, &site)))
            .basic_auth(email, Some(token))
            .header("Accept", "application/json"))
    }

    async fn jira_send(&self, req: reqwest::RequestBuilder) -> Res<Vec<u8>> {
        let (status, body) = send(req).await?;
        if !(200..300).contains(&status) {
            return Err(jira::parse_error(status, &body, &self.conn.site).into());
        }
        Ok(body)
    }

    fn clickup(&self, method: reqwest::Method, path: &str) -> Res<reqwest::RequestBuilder> {
        Ok(client()?
            .request(method, format!("{}{path}", base(TrackerKind::Clickup, "")))
            .header("Authorization", &self.token))
    }

    async fn clickup_send(&self, req: reqwest::RequestBuilder) -> Res<Vec<u8>> {
        let (status, body) = send(req).await?;
        if !(200..300).contains(&status) {
            return Err(clickup::parse_error(status, &body).into());
        }
        Ok(body)
    }
}

/// A Linear error as the user reads it: a rejected OAuth sign-in asks to sign in again (X44).
fn linear_error(e: ApiError, auth: &str) -> TrackerError {
    if e.auth && auth == "oauth" {
        sign_in_again()
    } else {
        e.into()
    }
}

/// An OAuth access token that is good for at least a minute. Each refresh
/// spends the refresh token, so refreshes run one at a time, and a command
/// that waited uses the tokens the first one saved (X44).
async fn fresh_access<F, Fut>(
    read: impl Fn() -> Res<moonlet_trackers::oauth::Tokens>,
    save: impl Fn(&moonlet_trackers::oauth::Tokens) -> Res<()>,
    now: impl Fn() -> u64,
    refresh: F,
) -> Res<String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Res<moonlet_trackers::oauth::Tokens>>,
{
    let tokens = read()?;
    if !tokens.needs_refresh(now()) {
        return Ok(tokens.access);
    }
    let _one = REFRESHING.lock().await;
    let tokens = read()?;
    if !tokens.needs_refresh(now()) {
        return Ok(tokens.access);
    }
    let token = tokens.refresh.ok_or_else(sign_in_again)?;
    let fresh = refresh(token).await?;
    save(&fresh)?;
    Ok(fresh.access)
}

async fn linear_request(token: &str, auth: &str, query: &str, variables: Value) -> Res<Vec<u8>> {
    // Personal API keys go as they are; OAuth tokens as Bearer.
    let header = if auth == "oauth" { format!("Bearer {token}") } else { token.to_string() };
    let (status, body) = send(
        client()?
            .post(format!("{}/graphql", base(TrackerKind::Linear, "")))
            .header("Authorization", header)
            .json(&json!({ "query": query, "variables": variables })),
    )
    .await?;
    if status == 401 {
        return Err(linear_error(ApiError { auth: true, message: linear::REJECTED.into() }, auth));
    }
    Ok(body)
}

/// What a Linear OAuth connection whose sign-in ran out says (X44).
fn sign_in_again() -> TrackerError {
    TrackerError { auth: true, message: "Sign in to Linear again".into() }
}
/// One OAuth refresh at a time (see `Session::load`).
static REFRESHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Linear's OAuth app, when this build has one (X44). Without it the app
/// signs in with an API key.
const LINEAR_CLIENT_ID: Option<&str> = option_env!("MOONLET_LINEAR_CLIENT_ID");
/// Linear's redirect must match the registered one exactly, so the port is fixed.
const LINEAR_REDIRECT_PORT: u16 = 53682;

/// Whether "Sign in with Linear" is available in this build.
#[tauri::command]
pub fn tracker_oauth_available() -> bool {
    LINEAR_CLIENT_ID.is_some()
}

/// Serves the loopback redirect until the browser comes back with this
/// request's `state`, then gives the code. Other requests (a favicon) get a
/// plain answer and are ignored; the wait ends after `timeout`.
async fn wait_for_callback(listener: tokio::net::TcpListener, state: String, timeout: std::time::Duration) -> Res<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let serve = async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(fail)?;
            let mut buf = vec![0u8; 8192];
            // A connection that says nothing is dropped, so it can't hold up the callback.
            let Ok(read) = tokio::time::timeout(std::time::Duration::from_secs(2), sock.read(&mut buf)).await else { continue };
            let n = read.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
            let result = moonlet_trackers::oauth::parse_callback(path, &state);
            let body = match &result {
                Ok(_) => "Signed in to Linear. You can close this tab and go back to moonlet.",
                Err(e) if e == "not the sign-in callback" => "",
                Err(e) => e.as_str(),
            };
            let _ = sock
                .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
                .await;
            match result {
                Ok(code) => return Ok(code),
                Err(e) if e == "not the sign-in callback" => continue,
                Err(e) => return Err(fail(e)),
            }
        }
    };
    tokio::time::timeout(timeout, serve).await.map_err(|_| fail("the Linear sign-in timed out"))?
}

/// "Sign in with Linear": PKCE in the browser, the code back on 127.0.0.1,
/// tokens in the Keychain (X44).
#[tauri::command]
pub async fn tracker_oauth_linear(app: tauri::AppHandle) -> Res<Connected> {
    use moonlet_trackers::oauth;
    let client_id = LINEAR_CLIENT_ID.ok_or_else(|| fail("Linear sign-in isn't set up in this build; use an API key"))?;
    let verifier = oauth::pkce_verifier(random32()?);
    let state = oauth::pkce_verifier(random32()?);
    let redirect = format!("http://127.0.0.1:{LINEAR_REDIRECT_PORT}/callback");
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", LINEAR_REDIRECT_PORT))
        .await
        .map_err(|e| fail(format!("cannot listen for the sign-in on port {LINEAR_REDIRECT_PORT}: {e}")))?;
    let url = oauth::authorize_url(linear::AUTHORIZE, client_id, &redirect, &state, &oauth::pkce_challenge(&verifier), "read,write");
    tauri_plugin_opener::OpenerExt::opener(&app).open_url(url, None::<&str>).map_err(fail)?;
    let code = wait_for_callback(listener, state, std::time::Duration::from_secs(300)).await?;
    let (status, body) = send(
        client()?
            .post(linear::TOKEN)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(oauth::token_body(client_id, &code, &redirect, &verifier)),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(fail(format!("Linear refused the sign-in ({status})")));
    }
    let tokens = oauth::parse_tokens(&body, moonlet_core::paths::now_ms())?;
    let raw = linear_request(&tokens.access, "oauth", linear::ACCOUNT, json!({})).await?;
    let (org, name) = linear::parse_account(&raw)?;
    save_connection(TrackerKind::Linear, org, name, serde_json::to_string(&tokens).map_err(fail)?, "oauth").await
}

/// 32 random bytes from the OS, for the PKCE verifier and the state.
fn random32() -> Res<[u8; 32]> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| fail(format!("no randomness for the sign-in: {e}")))?;
    Ok(b)
}

/// A team, project or list a connection can show.
#[derive(Serialize, Default)]
pub struct SourceChoice {
    pub key: String,
    pub name: String,
    /// A Linear team that uses cycles, whose board can follow the active one (X50).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cycles: bool,
    /// A ClickUp list's space, and folder: `Engineering › Roadmap` (X50 Add a board).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Serialize)]
pub struct Connected {
    pub connection: Connection,
    pub sources: Vec<SourceChoice>,
}

#[derive(Deserialize)]
pub struct ConnectRequest {
    pub kind: TrackerKind,
    /// The Jira host; ignored for the others.
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub email: String,
    pub token: String,
}

fn pairs(list: Vec<(String, String)>) -> Vec<SourceChoice> {
    list.into_iter().map(|(key, name)| SourceChoice { key, name, ..Default::default() }).collect()
}

/// Signs in with a token, keeps it in the Keychain and adds (or replaces) the
/// connection in `trackers.toml`, keeping the sources it had (X44).
#[tauri::command]
pub async fn tracker_connect(req: ConnectRequest) -> Res<Connected> {
    let token = req.token.trim().to_string();
    if token.is_empty() {
        return Err(fail("paste a token first"));
    }
    let (site, account, secret, auth) = match req.kind {
        TrackerKind::Linear => {
            let raw = linear_request(&token, "api_key", linear::ACCOUNT, json!({})).await?;
            let (org, name) = linear::parse_account(&raw)?;
            (org, name, token.clone(), "api_key")
        }
        TrackerKind::Jira => {
            if req.email.trim().is_empty() {
                return Err(fail("Jira needs the site, your email and an API token"));
            }
            let site = jira_site(&req.site)?;
            let s = Session { conn: placeholder(TrackerKind::Jira, &site), token: format!("{}:{token}", req.email.trim()) };
            let raw = s.jira_send(s.jira(reqwest::Method::GET, "/rest/api/3/myself")?).await?;
            let (_, name) = jira::parse_myself(&raw)?;
            (site, name, s.token, "token")
        }
        TrackerKind::Clickup => {
            let s = Session { conn: placeholder(TrackerKind::Clickup, ""), token: token.clone() };
            let user = clickup::parse_user(&s.clickup_send(s.clickup(reqwest::Method::GET, "/user")?).await?)?;
            let teams = clickup::parse_teams(&s.clickup_send(s.clickup(reqwest::Method::GET, "/team")?).await?)?;
            let team = teams.first().ok_or_else(|| fail("this ClickUp account has no workspace"))?;
            (team.0.clone(), user, token.clone(), "token")
        }
        TrackerKind::Github => return Err(fail("GitHub uses gh's own login")),
    };
    save_connection(req.kind, site, account, secret, auth).await
}

/// Keeps the token in the Keychain and adds (or replaces) the connection in
/// `trackers.toml`, keeping what the user picked (sources, state mapping).
async fn save_connection(kind: TrackerKind, site: String, account: String, secret: String, auth: &str) -> Res<Connected> {
    let id = connection_id(kind, &site);
    secrets::store().set(&id, &secret).map_err(fail)?;
    let path = crate::trackers_path();
    let mut config: TrackersConfig = crate::read_trackers(&path).map_err(fail)?;
    let old = config.connections.iter().find(|c| c.id == id).cloned();
    let (sources, states) = old.map(|c| (c.sources, c.states)).unwrap_or_default();
    config.connections.retain(|c| c.id != id);
    // Jira's secret is `email:token`; the email is not secret and fills Reconnect.
    let email = (kind == TrackerKind::Jira).then(|| secret.split_once(':').map(|(e, _)| e.to_string())).flatten();
    let connection = Connection { id: id.clone(), kind, site, account, auth: auth.into(), email, sources, states };
    config.connections.push(connection.clone());
    crate::write_trackers(&path, &config).map_err(fail)?;
    let sources = tracker_sources(id).await?;
    Ok(Connected { connection, sources })
}

fn placeholder(kind: TrackerKind, site: &str) -> Connection {
    Connection {
        id: connection_id(kind, site),
        kind,
        site: site.into(),
        account: String::new(),
        auth: "token".into(),
        email: None,
        sources: vec![],
        states: Default::default(),
    }
}

/// Forgets a connection: its token and its entry. Session links stay (X44).
#[tauri::command]
pub fn tracker_disconnect(id: String) -> Res<()> {
    secrets::store().delete(&id);
    let path = crate::trackers_path();
    let mut config = crate::read_trackers(&path).map_err(fail)?;
    config.connections.retain(|c| c.id != id);
    // Its boards go with it (X50).
    config.boards.retain(|b| b.connection != id);
    crate::write_trackers(&path, &config).map_err(fail)
}

/// The teams, projects or lists a connection can show.
#[tauri::command]
pub async fn tracker_sources(id: String) -> Res<Vec<SourceChoice>> {
    let s = Session::load(&id).await?;
    Ok(match s.conn.kind {
        TrackerKind::Linear => s
            .linear_ok(linear::parse_teams(&s.linear(linear::TEAMS, json!({})).await?))?
            .into_iter()
            .map(|t| SourceChoice { key: t.key, name: t.name, cycles: t.cycles, ..Default::default() })
            .collect(),
        TrackerKind::Jira => pairs(jira::parse_projects(&s.jira_send(s.jira(reqwest::Method::GET, "/rest/api/3/project/search?maxResults=100")?).await?)?),
        TrackerKind::Clickup => {
            let team = safe_id(&s.conn.site)?;
            let raw = s.clickup_send(s.clickup(reqwest::Method::GET, &format!("/team/{team}/space"))?).await?;
            let mut lists = Vec::new();
            // Grouped by space, and folder (X50 Add a board).
            for (space, space_name) in clickup::parse_spaces(&raw)? {
                let space = safe_id(&space)?;
                let raw = s.clickup_send(s.clickup(reqwest::Method::GET, &format!("/space/{space}/list"))?).await?;
                let group = |folder: Option<&str>| Some(clickup::list_group(&space_name, folder));
                lists.extend(clickup::parse_lists(&raw)?.into_iter().map(|(key, name)| SourceChoice { key, name, group: group(None), ..Default::default() }));
                let raw = s.clickup_send(s.clickup(reqwest::Method::GET, &format!("/space/{space}/folder"))?).await?;
                lists.extend(
                    clickup::parse_folder_lists(&raw)?
                        .into_iter()
                        .map(|(key, name, folder)| SourceChoice { key, name, group: group(Some(&folder)), ..Default::default() }),
                );
            }
            lists
        }
        TrackerKind::Github => vec![],
    })
}

/// One task of a connection by its key, wherever it is (X46: a key or URL
/// pasted into the link dialog); `None` when the tracker has no such task.
#[tauri::command]
pub async fn tracker_task(id: String, key: String) -> Res<Option<TrackerTask>> {
    let s = Session::load(&id).await?;
    safe_id(&key)?;
    match s.conn.kind {
        TrackerKind::Linear => {
            let raw = s.linear(&linear::issue_query(), json!({ "id": key })).await?;
            s.linear_ok(linear::parse_issue(&raw, &s.conn.id))
        }
        TrackerKind::Jira => {
            let (status, body) = send(s.jira(reqwest::Method::GET, &jira::issue_path(&key))?).await?;
            match status {
                404 => Ok(None),
                200..300 => Ok(Some(jira::parse_issue(&body, &s.conn.id, &s.conn.site)?)),
                _ => Err(jira::parse_error(status, &body, &s.conn.site).into()),
            }
        }
        TrackerKind::Clickup => {
            let team = safe_id(&s.conn.site)?;
            let (status, body) = send(s.clickup(reqwest::Method::GET, &clickup::task_path(&key, team))?).await?;
            match status {
                404 => Ok(None),
                200..300 => Ok(Some(clickup::parse_task(&body, &s.conn.id)?)),
                _ => Err(clickup::parse_error(status, &body).into()),
            }
        }
        TrackerKind::Github => Ok(None),
    }
}

impl Session {
    /// A ClickUp list's tasks, the user's own when `mine` (X44 Sync): open
    /// ones, and closed ones of the board's finished days, with due dates.
    async fn clickup_tasks(&self, list: &str, mine: bool, finished: &Finished) -> Res<Vec<BoardIssue>> {
        let me = if mine { clickup::parse_user_id(&self.clickup_send(self.clickup(reqwest::Method::GET, "/user")?).await?)? } else { String::new() };
        let since = clickup::closed_since(moonlet_core::paths::now_ms(), finished);
        let list = safe_id(list)?;
        let mut passes = [Vec::new(), Vec::new()];
        for (pass, closed_since) in passes.iter_mut().zip([None, Some(since)]) {
            for page in 0..5 {
                let path = clickup::tasks_path(list, (!me.is_empty()).then_some(me.as_str()), page, closed_since);
                let raw = self.clickup_send(self.clickup(reqwest::Method::GET, &path)?).await?;
                pass.extend(clickup::parse_board_tasks(&raw, &self.conn.id)?);
                if !clickup::more_pages(&raw) {
                    break;
                }
            }
        }
        let [open, recent] = passes;
        Ok(clickup::merge_passes(open, recent, &self.conn.states))
    }
}

/// The Jira boards a connection can show (X50 Add a board, step 1), at most
/// 20 pages of 50.
#[tauri::command]
pub async fn tracker_boards(id: String) -> Res<Vec<JiraBoard>> {
    let s = Session::load(&id).await?;
    if s.conn.kind != TrackerKind::Jira {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for _ in 0..20 {
        let path = format!("/rest/agile/1.0/board?maxResults=50&startAt={}", out.len());
        let (page, last) = jira_board::parse_boards(&s.jira_send(s.jira(reqwest::Method::GET, &path)?).await?)?;
        let empty = page.is_empty();
        out.extend(page);
        if last || empty {
            break;
        }
    }
    Ok(out)
}

impl Session {
    fn only_jira(&self) -> Res<()> {
        if self.conn.kind == TrackerKind::Jira { Ok(()) } else { Err(fail(format!("{} is not a Jira connection", self.conn.id))) }
    }

    /// A Jira board's configuration with each column's suggested category,
    /// in `sync` (none: read afresh).
    async fn jira_setup(&self, board: u64, sync: Option<u64>) -> Res<BoardSetup> {
        self.only_jira()?;
        let config = self.jira_get(&format!("/rest/agile/1.0/board/{board}/configuration"), sync).await?;
        let statuses = self.jira_get("/rest/api/3/status", sync).await?;
        Ok(jira_board::parse_board_config(&config, &jira_board::parse_statuses(&statuses)?)?)
    }

    /// A Jira GET; in a sync, one the connection's boards share there when
    /// [`crate::shared::shared_in_a_sync`] says so (X50 Sync).
    async fn jira_get(&self, path: &str, sync: Option<u64>) -> Res<Vec<u8>> {
        let ask = || async { self.jira_send(self.jira(reqwest::Method::GET, path)?).await };
        match sync {
            Some(sync) if crate::shared::shared_in_a_sync(path) => crate::shared::SYNC_ANSWERS.get(&format!("{} {sync} {path}", self.conn.id), moonlet_core::paths::now_ms, ask).await,
            _ => ask().await,
        }
    }

    /// A source's states; in a sync, asked once there (X50).
    async fn states_in(&self, source: &str, sync: Option<u64>) -> Res<Vec<(String, String)>> {
        let Some(sync) = sync else { return self.states_of(source).await };
        let ask = || async { serde_json::to_vec(&self.states_of(source).await?).map_err(fail) };
        let raw = crate::shared::SYNC_ANSWERS.get(&format!("{} {sync} states {source}", self.conn.id), moonlet_core::paths::now_ms, ask).await?;
        serde_json::from_slice(&raw).map_err(fail)
    }
}

/// A Jira board's columns, filter (with its JQL) and story points field
/// (X50 Add a board, steps 2 and 3).
#[tauri::command]
pub async fn tracker_board_setup(id: String, board: u64) -> Res<BoardSetup> {
    let s = Session::load(&id).await?;
    // Add a board reads Jira afresh: the user may just have changed the board there.
    let mut setup = s.jira_setup(board, None).await?;
    let filter_id = safe_id(&setup.filter_id)?.to_string();
    // A filter the user may not read leaves the board's columns to pick from.
    setup.filter_jql = match s.jira_send(s.jira(reqwest::Method::GET, &format!("/rest/api/3/filter/{filter_id}"))?).await {
        Ok(raw) => jira_board::parse_filter(&raw).ok(),
        Err(_) => None,
    };
    Ok(setup)
}

/// A GitHub Project's columns (X50): No Status, then each Status option, its
/// category by its name (X44's rule).
#[tauri::command]
pub fn github_project_columns(options: Vec<String>) -> Vec<BoardColumn> {
    moonlet_trackers::states::project_columns(&options)
}

/// What `tracker_board_tasks` searches with: a board's origin and filters.
#[derive(Deserialize)]
pub struct BoardQuery {
    pub id: String,
    pub origin: Origin,
    #[serde(default)]
    pub narrow: String,
    pub mine: bool,
    pub finished: Finished,
    /// The sync this read is in: its reads share the connection's lookups
    /// (X50). None for a preview, which reads everything afresh.
    #[serde(default)]
    pub sync: Option<u64>,
}

#[derive(Serialize)]
pub struct BoardTasks {
    pub issues: Vec<BoardIssue>,
    pub sprint: Option<Sprint>,
    /// A Jira board's columns as Jira has them now, or a JQL board's from its
    /// issues' statuses, to match the saved ones.
    pub columns: Option<Vec<BoardColumn>>,
    /// A Jira board's type (`scrum`, `kanban`, `simple`), for the switcher.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// A JQL board's site status names by id, so a column whose status no
    /// issue is in today shows by its name.
    #[serde(rename = "statusNames", skip_serializing_if = "Option::is_none")]
    pub status_names: Option<std::collections::BTreeMap<String, String>>,
}

/// A board's issues (X50 Sync): a Jira board's filter and sub-filter, or a
/// JQL board's query, with moonlet's narrowing; at most 5 pages.
#[tauri::command]
pub async fn tracker_board_tasks(query: BoardQuery) -> Res<BoardTasks> {
    let s = Session::load(&query.id).await?;
    // A Linear team: its open issues and those finished lately, or its active
    // cycle's, and its states as columns.
    if let Origin::LinearTeam { team } = &query.origin {
        let team = safe_id(team)?.to_string();
        let search = linear::board_issues_query(query.mine, &query.finished);
        let mut issues = Vec::new();
        let mut after: Option<String> = None;
        // At most 500 issues, as for Jira.
        for _ in 0..5 {
            let raw = s.linear(&search, json!({ "team": team, "after": after })).await?;
            issues.extend(s.linear_ok(linear::parse_board_issues(&raw, &s.conn.id))?);
            after = linear::next_page(&raw);
            if after.is_none() {
                break;
            }
        }
        let sprint = match query.finished {
            Finished::Sprint => s.linear_ok(linear::parse_active_cycle(&s.linear(linear::ACTIVE_CYCLE, json!({ "team": team })).await?))?,
            Finished::Days(_) => None,
        };
        let columns = moonlet_trackers::states::board_columns(s.conn.kind, &s.states_in(&team, query.sync).await?);
        return Ok(BoardTasks { issues, sprint, columns: Some(columns), kind: None, status_names: None });
    }
    // A ClickUp list: X44's fetch of that one source, and its states as columns.
    if let Origin::ClickupList { list: key } = &query.origin {
        let issues = s.clickup_tasks(key, query.mine, &query.finished).await?;
        let columns = moonlet_trackers::states::board_columns(s.conn.kind, &s.states_in(key, query.sync).await?);
        return Ok(BoardTasks { issues, sprint: None, columns: Some(columns), kind: None, status_names: None });
    }
    if !matches!(query.origin, Origin::JiraBoard { .. } | Origin::Jql { .. }) {
        return Ok(BoardTasks { issues: vec![], sprint: None, columns: None, kind: None, status_names: None });
    }
    s.only_jira()?;
    // A token Jira no longer accepts makes searches come back empty, not
    // refused: ask who we are first, which does fail. A sync asks once for
    // all the connection's boards (X50).
    s.jira_get("/rest/api/3/myself", query.sync).await?;
    let (filter, sub_query, points, board, columns, kind) = match &query.origin {
        Origin::JiraBoard { board } => {
            let setup = s.jira_setup(*board, query.sync).await?;
            let filter_id = safe_id(&setup.filter_id)?.to_string();
            let filter = jira_board::parse_filter(&s.jira_get(&format!("/rest/api/3/filter/{filter_id}"), query.sync).await?)?;
            (filter, setup.sub_query, setup.points_field, Some(*board), Some(setup.columns), Some(setup.kind))
        }
        Origin::Jql { query: jql } => (jql.clone(), None, None, None, None, None),
        _ => unreachable!("checked above"),
    };
    // A site that won't list its fields just gives no sprint.
    let sprint = match s.jira_get("/rest/api/3/field", query.sync).await {
        Ok(raw) => jira_board::sprint_field(&raw).unwrap_or(None),
        Err(_) => None,
    };
    let fields = SearchFields { sprint, points };
    let jql = jira_board::board_jql(&filter, sub_query.as_deref(), &query.narrow, query.mine, query.finished);
    let mut issues = Vec::new();
    let mut sprint = None;
    let mut token: Option<String> = None;
    for _ in 0..5 {
        let body = jira_board::board_search_body(&jql, &fields, token.as_deref());
        let raw = s.jira_send(s.jira(reqwest::Method::POST, "/rest/api/3/search/jql")?.json(&body)).await?;
        let (page, found) = jira_board::parse_board_search(&raw, &s.conn.id, &s.conn.site, &fields, board)?;
        issues.extend(page);
        sprint = sprint.or(found);
        token = jira::next_page(&raw);
        if token.is_none() || issues.len() >= 500 {
            break;
        }
    }
    // A JQL board's columns are the statuses its issues are in, named by the
    // site's statuses; a site that won't list them leaves the names to its issues.
    let jql = matches!(query.origin, Origin::Jql { .. });
    let columns = columns.or_else(|| jql.then(|| jira_board::columns_from_issues(&issues)));
    let status_names = if jql {
        let raw = s.jira_get("/rest/api/3/status", query.sync).await.ok();
        raw.and_then(|raw| jira_board::parse_statuses(&raw).ok()).map(|st| jira_board::status_names(&st))
    } else {
        None
    };
    Ok(BoardTasks { issues, sprint, columns, kind, status_names })
}

/// A tracker state and the column it lands in by default.
#[derive(Serialize)]
pub struct StateChoice {
    pub name: String,
    pub column: Column,
}

/// The states of a source, for the state mapping (X44 Workflow states).
#[tauri::command]
pub async fn tracker_states(id: String, source: String) -> Res<Vec<StateChoice>> {
    let s = Session::load(&id).await?;
    let kind = s.conn.kind;
    Ok(s.states_of(&source)
        .await?
        .into_iter()
        .map(|(name, category)| StateChoice { column: moonlet_trackers::states::default_column(kind, &category, &name), name })
        .collect())
}

impl Session {
    /// `(name, type)` of a Linear team's, Jira project's or ClickUp list's states.
    async fn states_of(&self, source: &str) -> Res<Vec<(String, String)>> {
        let source = safe_id(source)?.to_string();
        Ok(match self.conn.kind {
            TrackerKind::Linear => {
                let states = self.linear_ok(linear::parse_states(&self.linear(linear::STATES, json!({ "team": source })).await?))?;
                states.into_iter().map(|x| (x.name, x.kind)).collect()
            }
            TrackerKind::Jira => jira::parse_project_statuses(&self.jira_send(self.jira(reqwest::Method::GET, &format!("/rest/api/3/project/{source}/statuses"))?).await?)?,
            TrackerKind::Clickup => {
                let raw = self.clickup_send(self.clickup(reqwest::Method::GET, &format!("/list/{source}"))?).await?;
                clickup::parse_statuses(&raw)?.into_iter().map(|x| (x.name, x.kind)).collect()
            }
            TrackerKind::Github => vec![],
        })
    }
}

#[derive(Deserialize)]
pub struct MoveRequest {
    pub id: String,
    /// The issue's id in the tracker (`TrackerRef.id`).
    pub task: String,
    /// Its team, project or list (`TrackerRef.source`).
    pub source: String,
    pub column: Option<Column>,
    /// A board column's status (X50): a Jira status id, else a state's name.
    /// It wins over `column`.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub assign_me: bool,
    #[serde(default)]
    pub comment: Option<String>,
}

/// Moves an issue to a column, assigns it to the user and/or comments on it
/// (X46 Keep in step).
#[tauri::command]
pub async fn tracker_update(req: MoveRequest) -> Res<()> {
    let s = Session::load(&req.id).await?;
    safe_id(&req.task)?;
    safe_id(&req.source)?;
    match s.conn.kind {
        TrackerKind::Linear => {
            let mut input = json!({});
            if req.status.is_some() || req.column.is_some() {
                let states = s.linear_ok(linear::parse_states(&s.linear(linear::STATES, json!({ "team": req.source })).await?))?;
                let state = match (&req.status, req.column) {
                    (Some(status), _) => linear::state_named(&states, status),
                    (None, Some(column)) => linear::state_for(&states, column, &s.conn.states),
                    (None, None) => None,
                };
                let state = state.ok_or_else(|| fail(format!("{} has no state for that column", req.source)))?;
                input["stateId"] = json!(state.id);
            }
            if req.assign_me {
                let raw = s.linear(linear::VIEWER, json!({})).await?;
                input["assigneeId"] = json!(s.linear_ok(linear::parse_viewer_id(&raw))?);
            }
            if input.as_object().is_some_and(|o| !o.is_empty()) {
                s.linear_ok(linear::parse_success(&s.linear(linear::ISSUE_UPDATE, json!({ "id": req.task, "input": input })).await?, "issueUpdate"))?;
            }
            if let Some(text) = req.comment {
                let raw = s.linear(linear::COMMENT, json!({ "input": { "issueId": req.task, "body": text } })).await?;
                s.linear_ok(linear::parse_success(&raw, "commentCreate"))?;
            }
        }
        TrackerKind::Jira => {
            if req.status.is_some() || req.column.is_some() {
                let path = format!("/rest/api/3/issue/{}/transitions", req.task);
                let ts = jira::parse_transitions(&s.jira_send(s.jira(reqwest::Method::GET, &path)?).await?)?;
                let t = match (&req.status, req.column) {
                    (Some(status), _) => jira::transition_to_status(&ts, status),
                    (None, Some(column)) => jira::transition_to(&ts, column, &s.conn.states),
                    (None, None) => None,
                };
                let t = t.ok_or_else(|| fail("No Jira transition leads to that column from here"))?;
                s.jira_send(s.jira(reqwest::Method::POST, &path)?.json(&jira::transition_body(&t.id))).await?;
            }
            if req.assign_me {
                let (account, _) = jira::parse_myself(&s.jira_send(s.jira(reqwest::Method::GET, "/rest/api/3/myself")?).await?)?;
                let path = format!("/rest/api/3/issue/{}/assignee", req.task);
                s.jira_send(s.jira(reqwest::Method::PUT, &path)?.json(&jira::assignee_body(&account))).await?;
            }
            if let Some(text) = req.comment {
                let path = format!("/rest/api/3/issue/{}/comment", req.task);
                s.jira_send(s.jira(reqwest::Method::POST, &path)?.json(&jira::comment_body(&text))).await?;
            }
        }
        TrackerKind::Clickup => {
            let mut body = json!({});
            if let Some(status) = &req.status {
                body["status"] = json!(status);
            } else if let Some(column) = req.column {
                let list = clickup::parse_statuses(&s.clickup_send(s.clickup(reqwest::Method::GET, &format!("/list/{}", req.source))?).await?)?;
                let status = clickup::status_for(&list, column, &s.conn.states).ok_or_else(|| fail("this list has no status for that column"))?;
                body["status"] = json!(status.name);
            }
            if req.assign_me {
                let me = clickup::parse_user_id(&s.clickup_send(s.clickup(reqwest::Method::GET, "/user")?).await?)?;
                let me: u64 = me.parse().map_err(|_| fail("ClickUp did not say who you are"))?;
                body["assignees"] = json!({ "add": [me] });
            }
            if body.as_object().is_some_and(|o| !o.is_empty()) {
                s.clickup_send(s.clickup(reqwest::Method::PUT, &format!("/task/{}", req.task))?.json(&body)).await?;
            }
            if let Some(text) = req.comment {
                let path = format!("/task/{}/comment", req.task);
                s.clickup_send(s.clickup(reqwest::Method::POST, &path)?.json(&clickup::comment_body(&text))).await?;
            }
        }
        TrackerKind::Github => return Err(fail("GitHub goes through gh")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlet_trackers::oauth::Tokens;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn two_commands_at_once_spend_the_refresh_token_once() {
        // Linear issues a new refresh token on each refresh and refuses the old one.
        let saved = Arc::new(Mutex::new(Tokens { access: "a1".into(), refresh: Some("r1".into()), expires_ms: 0 }));
        let load = || {
            let saved = saved.clone();
            async move {
                fresh_access(
                    || Ok(saved.lock().unwrap().clone()),
                    |t: &Tokens| Ok(*saved.lock().unwrap() = t.clone()),
                    || 1_000,
                    |refresh: String| {
                        let saved = saved.clone();
                        async move {
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                            if saved.lock().unwrap().refresh.as_deref() != Some(refresh.as_str()) {
                                return Err(fail("invalid_grant"));
                            }
                            Ok(Tokens { access: "a2".into(), refresh: Some("r2".into()), expires_ms: u64::MAX })
                        }
                    },
                )
                .await
            }
        };
        let (one, two) = tokio::join!(load(), load());
        assert_eq!((one.unwrap(), two.unwrap()), ("a2".to_string(), "a2".to_string()));
    }

    #[test]
    fn a_rejected_linear_token_reads_as_its_kind_of_sign_in() {
        let rejected = || ApiError { auth: true, message: "Linear no longer accepts this token. Create a new one and paste it here.".into() };
        assert_eq!(linear_error(rejected(), "oauth").message, "Sign in to Linear again");
        assert_eq!(linear_error(rejected(), "api_key").message, "Linear no longer accepts this token. Create a new one and paste it here.");
        assert_eq!(linear_error(ApiError::new("Rate limit exceeded"), "oauth").message, "Rate limit exceeded");
    }

    #[tokio::test]
    async fn a_silent_connection_does_not_hold_up_the_callback() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let waiting = tokio::spawn(wait_for_callback(listener, "st4te".into(), std::time::Duration::from_secs(20)));
        // Something on this Mac connects and never says anything.
        let _silent = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
        c.write_all(b"GET /callback?code=abc&state=st4te HTTP/1.1\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        c.read_to_string(&mut answer).await.unwrap();
        let code = tokio::time::timeout(std::time::Duration::from_secs(10), waiting).await.expect("the callback was held up").unwrap();
        assert_eq!(code.unwrap(), "abc");
    }

    #[tokio::test]
    async fn the_loopback_listener_waits_for_the_callback_with_its_state() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let waiting = tokio::spawn(wait_for_callback(listener, "st4te".into(), std::time::Duration::from_secs(5)));
        // A browser asks for the favicon first; that is not the callback.
        for path in ["/favicon.ico", "/callback?code=abc&state=st4te"] {
            let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
            c.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.unwrap();
            let mut answer = String::new();
            c.read_to_string(&mut answer).await.unwrap();
            assert!(answer.starts_with("HTTP/1.1"), "{answer}");
        }
        assert_eq!(waiting.await.unwrap().unwrap(), "abc");
    }

    #[test]
    fn only_a_jira_cloud_host_gets_the_token() {
        assert_eq!(jira_site(" https://ACME.atlassian.net/ ").unwrap(), "acme.atlassian.net");
        assert_eq!(jira_site("acme.jira.com").unwrap(), "acme.jira.com");
        for bad in ["evil.com", "user@evil.com#.atlassian.net", "evil.com/.atlassian.net", "acme.atlassian.net.evil.com", ".atlassian.net"] {
            assert!(jira_site(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ids_in_a_url_path_are_plain() {
        assert_eq!(safe_id("10002").unwrap(), "10002");
        assert_eq!(safe_id("ENG-42").unwrap(), "ENG-42");
        for bad in ["../myself", "1/transitions", "a?b", ""] {
            assert!(safe_id(bad).is_err(), "{bad}");
        }
    }
}
