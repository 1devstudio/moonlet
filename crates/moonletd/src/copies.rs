//! Design systems and workspace designs on every member (X71). Each item
//! has a record in the account, kept by its owner: the member where its
//! agent runs. The owner snapshots its folder as a git tree, sends the
//! central host what it lacks, and names the tree in the record. Every
//! other member fetches that tree from the central host and keeps a
//! read-only copy of the folder.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use moonlet_core::design::replica::{Item, Kind, Replicas};
use moonlet_core::design::store::Store;
use moonlet_core::session::SessionManager;
use moonlet_proto::RpcError;
use moonlet_proto::methods as m;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::link::WorkerLink;

/// An item's account record, as read from its fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rec {
    pub item: Item,
    pub name: String,
    /// The owner's worker id.
    pub owner: String,
    /// The latest snapshot the owner published.
    pub tree: Option<String>,
    /// Whether the owner's agent is working on it: the owner's own
    /// `agent:<worker id>` field, so a former owner's late word never
    /// counts.
    pub agent: bool,
}

impl Rec {
    /// A record from its fields; none while a field it needs is missing.
    pub fn parse(fields: &BTreeMap<String, Value>) -> Option<Rec> {
        let text = |f: &str| fields.get(f).and_then(Value::as_str).map(String::from);
        let kind = match text("kind")?.as_str() {
            "system" => Kind::System,
            "design" => Kind::Design,
            _ => return None,
        };
        Some(Rec {
            item: Item {
                workspace: text("workspace")?,
                kind,
                slug: text("slug")?,
            },
            name: text("name").unwrap_or_default(),
            owner: text("owner")?,
            tree: text("tree"),
            // Only the owner's own field: each member writes its own.
            agent: fields
                .get(&agent_field(&text("owner")?))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

/// The field in which member `worker` says whether its agent works on an
/// item: one per member, so members never overwrite each other's.
pub fn agent_field(worker: &str) -> String {
    format!("agent:{worker}")
}

/// What this member keeps of an item, by its record's id, in
/// `~/.moonlet/design/.store/copies.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Local {
    pub workspace: String,
    /// `system` or `design`.
    pub kind: String,
    pub slug: String,
    /// The tree its folder holds: the one applied, or published.
    #[serde(default)]
    pub tree: Option<String>,
    /// Whether this member owns it.
    #[serde(default)]
    pub owned: bool,
}

impl Local {
    pub fn of(item: &Item, tree: Option<String>, owned: bool) -> Local {
        Local {
            workspace: item.workspace.clone(),
            kind: item.kind.as_str().into(),
            slug: item.slug.clone(),
            tree,
            owned,
        }
    }

    pub fn item(&self) -> Item {
        let kind = if self.kind == "design" {
            Kind::Design
        } else {
            Kind::System
        };
        Item {
            workspace: self.workspace.clone(),
            kind,
            slug: self.slug.clone(),
        }
    }
}

/// One thing to do to bring this member's folders and the records together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// A folder no record names: this member's own, to give a record. With
    /// `rename`, another member's item has its place, so it moves first.
    Claim { item: Item, rename: Option<String> },
    /// An item this member owns: snapshot it, and publish the tree when it
    /// changed.
    Publish { id: String, item: Item },
    /// An item this member owned whose folder is gone: removed.
    Unpublish { id: String },
    /// Another member's item: this member's copy takes `tree`, at `item`,
    /// leaving `from` when it was somewhere else.
    Copy {
        id: String,
        item: Item,
        tree: String,
        from: Option<Item>,
    },
    /// An item this member owned that another member owns now.
    Lost { id: String, item: Item },
    /// An item of this member's own whose place another member's record
    /// had first (the lower id keeps it): it moves to `to`.
    Rename { id: String, item: Item, to: String },
    /// An item this member owns whose workspace was merged away, found in
    /// the workspace it merged into: its record names its new place.
    Repoint { id: String, item: Item },
    /// An item whose record is gone: its copy goes.
    Drop { id: String, item: Item, owned: bool },
}

/// What to do, given the account's records (by id), what this member keeps
/// (by id) and the items whose folders are on its disk. `me` is this
/// member's worker id.
pub fn plan(
    me: &str,
    records: &BTreeMap<String, Rec>,
    kept: &BTreeMap<String, Local>,
    folders: &BTreeSet<Item>,
    merged: &BTreeMap<String, String>,
) -> Vec<Step> {
    let mut steps = Vec::new();
    let tracked: BTreeSet<Item> = kept.values().map(Local::item).collect();
    let mut taken: BTreeSet<Item> = folders
        .iter()
        .cloned()
        .chain(records.values().map(|r| r.item.clone()))
        .collect();
    let free = |item: &Item, taken: &BTreeSet<Item>| {
        (2..)
            .map(|n| Item {
                slug: format!("{}-{n}", item.slug),
                ..item.clone()
            })
            .find(|i| !taken.contains(i))
            .expect("a free slug")
    };
    // Each place's records: the lowest id keeps it, as on every member.
    let mut at: BTreeMap<&Item, Vec<&String>> = BTreeMap::new();
    for (id, r) in records {
        at.entry(&r.item).or_default().push(id);
    }
    let keeper = |id: &String, r: &Rec| at.get(&r.item).is_none_or(|ids| ids.first() == Some(&id));
    // An item this member keeps whose workspace was merged away, found in
    // the one it merged into: its folder, not a new item there.
    let mut repoints = Vec::new();
    let mut found: BTreeSet<Item> = BTreeSet::new();
    for (id, l) in kept {
        let item = l.item();
        if folders.contains(&item) {
            continue;
        }
        let Some(into) = merged.get(&item.workspace) else {
            continue;
        };
        let numbered = |slug: &str| {
            slug.strip_prefix(&format!("{}-", item.slug))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        };
        let candidates: Vec<&Item> = folders
            .iter()
            .filter(|i| {
                i.workspace == *into
                    && i.kind == item.kind
                    && !tracked.contains(i)
                    && !found.contains(*i)
            })
            .filter(|i| !records.values().any(|o| o.item == **i))
            .filter(|i| i.slug == item.slug || numbered(&i.slug))
            .collect();
        let Some(to) = candidates
            .iter()
            .find(|i| i.slug == item.slug)
            .or(candidates.first())
        else {
            continue;
        };
        found.insert((*to).clone());
        repoints.push(Step::Repoint {
            id: id.clone(),
            item: (*to).clone(),
        });
    }
    for item in folders
        .iter()
        .filter(|i| !tracked.contains(i) && !found.contains(*i))
    {
        let placed = records.values().find(|r| r.item == *item);
        match placed {
            // This member's own, its record already made: kept again.
            Some(r) if r.owner == me => continue,
            Some(_) => {
                let to = free(item, &taken);
                taken.insert(to.clone());
                steps.push(Step::Claim {
                    item: item.clone(),
                    rename: Some(to.slug),
                });
            }
            None => steps.push(Step::Claim {
                item: item.clone(),
                rename: None,
            }),
        }
    }
    steps.extend(repoints.iter().cloned());
    let repointed: BTreeSet<&String> = repoints
        .iter()
        .filter_map(|s| match s {
            Step::Repoint { id, .. } => Some(id),
            _ => None,
        })
        .collect();
    for (id, r) in records {
        let local = kept.get(id);
        if !keeper(id, r) {
            // Another record has this place: the one of this member's own
            // moves; another member's waits for its owner to move it.
            if r.owner == me && folders.contains(&r.item) {
                let to = free(&r.item, &taken);
                taken.insert(to.clone());
                steps.push(Step::Rename {
                    id: id.clone(),
                    item: r.item.clone(),
                    to: to.slug,
                });
            }
            continue;
        }
        if r.owner == me {
            if folders.contains(&r.item) {
                steps.push(Step::Publish {
                    id: id.clone(),
                    item: r.item.clone(),
                });
            } else if !repointed.contains(id) {
                steps.push(Step::Unpublish { id: id.clone() });
            }
            continue;
        }
        if let Some(l) = local.filter(|l| l.owned) {
            steps.push(Step::Lost {
                id: id.clone(),
                item: l.item(),
            });
        }
        // Not over an item of this member's own still in its place, nor
        // into a merged-away workspace before its owner moves it, nor over
        // a copy that is moving with a merge.
        let mine_here = records
            .iter()
            .any(|(o, x)| o != id && x.owner == me && x.item == r.item);
        if mine_here || merged.contains_key(&r.item.workspace) || repointed.contains(id) {
            continue;
        }
        let Some(tree) = &r.tree else { continue };
        let current = local.is_some_and(|l| {
            !l.owned
                && l.item() == r.item
                && l.tree.as_ref() == Some(tree)
                && folders.contains(&r.item)
        });
        if !current {
            steps.push(Step::Copy {
                id: id.clone(),
                item: r.item.clone(),
                tree: tree.clone(),
                from: local.map(Local::item).filter(|i| *i != r.item),
            });
        }
    }
    for (id, l) in kept.iter().filter(|(id, _)| !records.contains_key(*id)) {
        steps.push(Step::Drop {
            id: id.clone(),
            item: l.item(),
            owned: l.owned,
        });
    }
    steps
}

/// How long changes to the design folders must settle before a round.
fn quiet() -> Duration {
    std::env::var("MOONLET_DESIGN_COPY_QUIET_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(Duration::from_millis(800), Duration::from_millis)
}

/// A round even when nothing said so, for a fetch that failed.
const EVERY: Duration = Duration::from_secs(30);

type OnLost = Box<dyn Fn(&Item) + Send + Sync>;
type OnBusy = Box<dyn Fn(&Item) -> bool + Send + Sync>;

/// This member's side of X71: keeps its items' records and its copies.
pub struct DesignCopies {
    home: PathBuf,
    replicas: Replicas,
    store: Store,
    sessions: Arc<SessionManager>,
    link: Arc<WorkerLink>,
    /// One round at a time.
    round: tokio::sync::Mutex<()>,
    kick: tokio::sync::Notify,
    /// Called with an item this member no longer owns, to stop its agent.
    lost: Mutex<Option<OnLost>>,
    /// Whether an item's agent works on it, for its record's `agent`.
    busy: Mutex<Option<OnBusy>>,
    /// Items whose folders changed since the last round.
    dirty: Mutex<BTreeSet<Item>>,
    /// The link changed: offer every owned tree whole next round.
    reoffer: std::sync::atomic::AtomicBool,
    /// When a round last read every owned folder.
    full_at: Mutex<Option<std::time::Instant>>,
}

impl DesignCopies {
    pub fn new(
        home: &Path,
        sessions: Arc<SessionManager>,
        link: Arc<WorkerLink>,
    ) -> Arc<DesignCopies> {
        Arc::new(DesignCopies {
            home: home.to_path_buf(),
            replicas: Replicas::new(home),
            store: Store::new(home),
            sessions,
            link,
            round: tokio::sync::Mutex::new(()),
            kick: tokio::sync::Notify::new(),
            lost: Mutex::new(None),
            busy: Mutex::new(None),
            dirty: Mutex::new(BTreeSet::new()),
            reoffer: std::sync::atomic::AtomicBool::new(true),
            full_at: Mutex::new(None),
        })
    }

    /// Asks for a round soon.
    pub fn kick(&self) {
        self.kick.notify_one();
    }

    pub fn on_lost(&self, f: impl Fn(&Item) + Send + Sync + 'static) {
        *self.lost.lock().unwrap() = Some(Box::new(f));
    }

    pub fn on_busy(&self, f: impl Fn(&Item) -> bool + Send + Sync + 'static) {
        *self.busy.lock().unwrap() = Some(Box::new(f));
    }

    /// Runs rounds for the daemon's life: once now, then whenever kicked
    /// and the folders have settled, and every [`EVERY`].
    pub fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) = me.round().await {
                    tracing::warn!("design copies: {e:#}");
                }
                let _ = tokio::time::timeout(EVERY, me.kick.notified()).await;
                // Whatever else comes meanwhile joins this round.
                tokio::time::sleep(quiet()).await;
            }
        });
    }

    fn copies_file(&self) -> PathBuf {
        self.home.join("design").join(".store").join("copies.json")
    }

    /// What this member keeps, by record id. A file that is there but
    /// cannot be read stops the round: read as empty, every copy would
    /// look like an item of this member's own.
    fn load(&self) -> Result<BTreeMap<String, Local>> {
        match std::fs::read(self.copies_file()) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("cannot read {}", self.copies_file().display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(anyhow::Error::from(e)
                .context(format!("cannot read {}", self.copies_file().display()))),
        }
    }

    fn save(&self, kept: &BTreeMap<String, Local>) -> Result<()> {
        let path = self.copies_file();
        std::fs::create_dir_all(path.parent().context("no folder")?)?;
        let tmp = path.with_extension(format!("json.{}", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, serde_json::to_vec_pretty(kept)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// What this member keeps of item `item`, when it keeps it: its record
    /// id and whether it owns it.
    pub fn kept(&self, item: &Item) -> Option<(String, Local)> {
        self.load()
            .ok()?
            .into_iter()
            .find(|(_, l)| l.item() == *item)
    }

    /// The account's records of items, by id.
    pub fn records(&self) -> BTreeMap<String, Rec> {
        self.sessions
            .design_records()
            .iter()
            .filter_map(|(id, fields)| Some((id.clone(), Rec::parse(fields)?)))
            .collect()
    }

    /// Notes that item `item`'s folder changed, so the next round
    /// snapshots it.
    pub fn changed(&self, item: Item) {
        self.dirty.lock().unwrap().insert(item);
    }

    /// Notes that the link changed: the next round offers the central host
    /// every tree this member owns, whole, in case it lost them.
    pub fn link_changed(&self) {
        self.reoffer
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// One round: the records and this member's folders brought together.
    pub async fn round(&self) -> Result<()> {
        if !self.sessions.has_account() {
            return Ok(());
        }
        let info = self.link.info();
        if info.worker.cloud {
            return Ok(());
        }
        let me = info.worker.id;
        let _one = self.round.lock().await;
        let records = self.records();
        let mut kept = self.load()?;
        let folders = {
            let me = self.clone_ref();
            tokio::task::spawn_blocking(move || me.folders()).await??
        };
        let merged: BTreeMap<String, String> =
            self.sessions.merged_workspaces().into_iter().collect();
        let reoffer = self
            .reoffer
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        let full = {
            let mut last = self.full_at.lock().unwrap();
            let due = last.is_none_or(|t| t.elapsed() >= FULL);
            if due {
                *last = Some(std::time::Instant::now());
            }
            due
        };
        let dirty = std::mem::take(&mut *self.dirty.lock().unwrap());
        let mut round = Round {
            me: &me,
            records: &records,
            reoffer,
            full,
            dirty,
            blocked: BTreeSet::new(),
            offered: true,
        };
        for step in plan(&me, &records, &kept, &folders, &merged) {
            if let Err(e) = self.step(&mut round, &step, &mut kept).await {
                tracing::warn!(?step, "design copies: {e:#}");
                // A place still held by this member's own item takes no copy.
                if let Step::Claim { item, .. } | Step::Rename { item, .. } = &step {
                    round.blocked.insert(item.clone());
                }
                if matches!(step, Step::Publish { .. } | Step::Claim { .. }) {
                    round.offered = false;
                }
            }
            self.save(&kept)?;
        }
        // Tried again next round, until every tree reached the central host.
        if reoffer && !round.offered {
            self.reoffer
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }

    /// A handle for blocking work: the parts a scan needs.
    fn clone_ref(&self) -> Scan {
        Scan {
            home: self.home.clone(),
        }
    }

    async fn step(
        &self,
        round: &mut Round<'_>,
        step: &Step,
        kept: &mut BTreeMap<String, Local>,
    ) -> Result<()> {
        let me = round.me;
        match step {
            Step::Claim { item, rename } => {
                let item = match rename {
                    Some(to) => self.rename(item, to, kept).await?,
                    None => item.clone(),
                };
                let id = format!("d-{}", uuid::Uuid::new_v4().simple());
                let name = self.name_of(&item).unwrap_or_default();
                let busy = self.is_busy(&item);
                self.sessions.set_design(
                    &id,
                    &[
                        ("workspace", json!(item.workspace)),
                        ("kind", json!(item.kind.as_str())),
                        ("slug", json!(item.slug)),
                        ("name", json!(name)),
                        ("owner", json!(me)),
                        (agent_field(me).as_str(), json!(busy)),
                    ],
                );
                kept.insert(id.clone(), Local::of(&item, None, true));
                self.publish(round, &id, &item, None, kept).await
            }
            Step::Rename { id, item, to } => {
                let moved = self.rename(item, to, kept).await?;
                self.sessions.set_design(id, &[("slug", json!(moved.slug))]);
                let tree = kept.get(id).and_then(|l| l.tree.clone());
                kept.insert(id.clone(), Local::of(&moved, tree, true));
                Ok(())
            }
            Step::Repoint { id, item } => {
                let Some(l) = kept.get_mut(id) else {
                    return Ok(());
                };
                l.workspace = item.workspace.clone();
                l.slug = item.slug.clone();
                if l.owned {
                    self.sessions.set_design(
                        id,
                        &[
                            ("workspace", json!(item.workspace)),
                            ("slug", json!(item.slug)),
                        ],
                    );
                }
                Ok(())
            }
            Step::Publish { id, item } => {
                let had = kept.get(id).and_then(|l| l.tree.clone());
                kept.insert(id.clone(), Local::of(item, had, true));
                let published = round.records.get(id).and_then(|r| r.tree.clone());
                self.publish(round, id, item, published, kept).await?;
                let busy = self.is_busy(item);
                if round.records.get(id).is_some_and(|r| r.agent != busy) {
                    self.sessions
                        .set_design(id, &[(agent_field(me).as_str(), json!(busy))]);
                }
                Ok(())
            }
            Step::Unpublish { id } => {
                // Still this member's, as the record says now: another
                // member may have taken it over since the round began.
                if self.records().get(id).is_some_and(|r| r.owner == me) {
                    self.sessions.delete_design(id);
                }
                kept.remove(id);
                Ok(())
            }
            Step::Lost { id, item } => {
                if let Some(f) = self.lost.lock().unwrap().as_ref() {
                    f(item);
                }
                if let Some(l) = kept.get_mut(id) {
                    l.owned = false;
                }
                Ok(())
            }
            Step::Copy {
                id,
                item,
                tree,
                from,
            } => {
                if round.blocked.contains(item) {
                    bail!("{} is still this member's own item", item.slug);
                }
                self.fetch(tree, kept).await?;
                self.replicas.apply(item, tree, &self.locate()).await?;
                // The old place goes once the new one holds the copy.
                if let Some(from) = from {
                    self.remove_folder(from).await?;
                }
                kept.insert(id.clone(), Local::of(item, Some(tree.clone()), false));
                Ok(())
            }
            Step::Drop { id, item, owned } => {
                if !owned {
                    self.remove_folder(item).await?;
                }
                kept.remove(id);
                Ok(())
            }
        }
    }

    /// Moves this member's own item to slug `to`, which the plan picked
    /// free of every record; this member's own designs follow a renamed
    /// system, its copies do not.
    async fn rename(&self, item: &Item, to: &str, kept: &BTreeMap<String, Local>) -> Result<Item> {
        let store = self.store.clone();
        let (ws, kind, slug, to) = (
            item.workspace.clone(),
            item.kind.folder(),
            item.slug.clone(),
            to.to_string(),
        );
        let copies: BTreeSet<String> = kept
            .values()
            .filter(|l| !l.owned && l.workspace == ws && l.kind == "design")
            .map(|l| l.slug.clone())
            .collect();
        let moved = tokio::task::spawn_blocking(move || {
            store.rename_item(&ws, kind, &slug, Some(&to), &|d| !copies.contains(d))
        })
        .await??;
        Ok(Item {
            slug: moved,
            ..item.clone()
        })
    }

    fn is_busy(&self, item: &Item) -> bool {
        self.busy.lock().unwrap().as_ref().is_some_and(|f| f(item))
    }

    /// This member's project with an identity: its id and folder.
    fn locate(
        &self,
    ) -> impl Fn(&moonlet_proto::types::ProjectIdentity) -> Option<(String, String)> + Send + Sync + use<>
    {
        let projects = self.sessions.list_projects();
        move |identity| {
            projects
                .iter()
                .find(|p| moonlet_core::identity::same_project(&p.identity, identity))
                .map(|p| (p.id.clone(), p.path.clone()))
        }
    }

    /// The item's name, as its folder gives it.
    fn name_of(&self, item: &Item) -> Option<String> {
        match item.kind {
            Kind::System => self
                .store
                .config(&item.workspace, &item.slug)
                .ok()
                .map(|c| c.name),
            Kind::Design => {
                let at = self
                    .store
                    .workspace_design(&item.workspace, &item.slug)
                    .ok()?;
                self.store.design_config(&at).ok().map(|c| c.name)
            }
        }
    }

    async fn remove_folder(&self, item: &Item) -> Result<()> {
        let store = self.store.clone();
        let item = item.clone();
        tokio::task::spawn_blocking(move || match item.kind {
            Kind::System if store.system_dir(&item.workspace, &item.slug).is_ok() => {
                store.remove_system(&item.workspace, &item.slug)
            }
            Kind::Design => match store.workspace_design(&item.workspace, &item.slug) {
                Ok(at) => store.remove_design(&at),
                Err(_) => Ok(()),
            },
            _ => Ok(()),
        })
        .await?
    }

    /// Publishes an item this member owns when its tree changed. Its folder
    /// is read again only when it changed since, nothing was published yet,
    /// or every [`FULL`] (a change the watch missed). A member first sends
    /// the central host the objects it lacks, so a member reading the record
    /// can always fetch the tree; after the link changed, the whole tree,
    /// even unchanged, in case the central host lost it.
    async fn publish(
        &self,
        round: &Round<'_>,
        id: &str,
        item: &Item,
        published: Option<String>,
        kept: &mut BTreeMap<String, Local>,
    ) -> Result<()> {
        let had = kept.get(id).and_then(|l| l.tree.clone());
        let read = round.full || had.is_none() || had != published || round.dirty.contains(item);
        let tree = match (read, had) {
            (false, Some(t)) => t,
            _ => self.replicas.snapshot(item).await?,
        };
        let changed = published.as_deref() != Some(tree.as_str());
        if (changed || round.reoffer) && self.link.central_name().is_some() {
            let have: Vec<String> = if round.reoffer {
                Vec::new()
            } else {
                published.into_iter().collect()
            };
            if let Err(e) = self.offer(&tree, &have).await {
                // The central host may lack the base too: then all of it.
                if have.is_empty() {
                    return Err(e);
                }
                self.offer(&tree, &[]).await?;
            }
        }
        if changed {
            let name = self.name_of(item).unwrap_or_default();
            self.sessions
                .set_design(id, &[("tree", json!(tree)), ("name", json!(name))]);
        }
        if let Some(l) = kept.get_mut(id) {
            l.tree = Some(tree);
        }
        Ok(())
    }

    /// `design.offer`: sends the central host tree `tree`, without what a
    /// holder of the trees `have` has.
    async fn offer(&self, tree: &str, have: &[String]) -> Result<()> {
        let host = self
            .link
            .host()
            .context("the central host is not connected")?;
        let pack = self.replicas.pack(tree, have).await?;
        let pack = if pack.is_empty() {
            None
        } else {
            Some(host.send_pack(&pack).map_err(rpc)?)
        };
        host.request(
            m::DESIGN_OFFER,
            serde_json::to_value(m::DesignOffer {
                tree: tree.to_string(),
                pack,
            })?,
        )
        .await
        .map_err(rpc)?;
        Ok(())
    }

    /// Makes sure this member holds tree `tree`: from the central host,
    /// when it is a member.
    async fn fetch(&self, tree: &str, kept: &BTreeMap<String, Local>) -> Result<()> {
        if self.replicas.check(tree).await.is_ok() {
            return Ok(());
        }
        if self.link.central_name().is_none() {
            bail!("tree {tree} is not here yet");
        }
        let host = self
            .link
            .host()
            .context("the central host is not connected")?;
        let have: Vec<String> = kept
            .values()
            .filter_map(|l| l.tree.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let reply = host
            .request(
                m::DESIGN_FETCH,
                serde_json::to_value(m::DesignFetch {
                    tree: tree.to_string(),
                    have,
                })?,
            )
            .await
            .map_err(rpc)?;
        let fetched: m::DesignFetched = serde_json::from_value(reply)?;
        let pack = match fetched.pack {
            Some(t) => host
                .take_pack(t)
                .context("the design's files did not arrive")?,
            None => Vec::new(),
        };
        self.replicas.accept(&pack, tree).await
    }

    /// `design.offer`, on the central host: stores a member's snapshot.
    pub async fn offered(&self, tree: &str, pack: Option<Vec<u8>>) -> Result<bool, RpcError> {
        self.replicas
            .accept(&pack.unwrap_or_default(), tree)
            .await
            .map_err(|e| RpcError::new("refused", format!("{e:#}")))?;
        // A copy here may have waited for this tree.
        self.kick();
        Ok(true)
    }

    /// `design.fetch`, on the central host: the objects of `tree` a member
    /// holding the trees `have` lacks.
    pub async fn pack_for(&self, tree: &str, have: &[String]) -> Result<Vec<u8>, RpcError> {
        self.replicas
            .check(tree)
            .await
            .map_err(|e| RpcError::new("not_found", format!("{e:#}")))?;
        self.replicas
            .pack(tree, have)
            .await
            .map_err(|e| RpcError::new("failed", format!("{e:#}")))
    }

    /// Moves the design systems and designs of merged workspace `from` into
    /// `into` (X68), between rounds: copies too, and what this member keeps
    /// follows each; the records of its own name their new place. A stop
    /// before that is finished by the next round (see [`Step::Repoint`]).
    pub async fn merge(
        &self,
        from: &str,
        into: &str,
    ) -> Result<Vec<moonlet_core::design::merge::Moved>> {
        let _one = self.round.lock().await;
        let store = self.store.clone();
        let (f, i) = (from.to_string(), into.to_string());
        let moved = tokio::task::spawn_blocking(move || store.move_workspace(&f, &i)).await??;
        let mut kept = self.load()?;
        for mv in &moved {
            let Some((id, l)) = kept
                .iter_mut()
                .find(|(_, l)| l.workspace == from && l.kind == mv.kind && l.slug == mv.from)
            else {
                continue;
            };
            l.workspace = into.to_string();
            l.slug = mv.to.clone();
            if l.owned {
                self.sessions
                    .set_design(id, &[("workspace", json!(into)), ("slug", json!(mv.to))]);
            }
        }
        self.save(&kept)?;
        Ok(moved)
    }
}

/// What one round knows as it goes.
struct Round<'a> {
    me: &'a str,
    records: &'a BTreeMap<String, Rec>,
    /// Offer the central host every owned tree whole.
    reoffer: bool,
    /// Read every owned folder again.
    full: bool,
    /// The items whose folders changed since the last round.
    dirty: BTreeSet<Item>,
    /// Places a step of this member's own failed to clear: no copy there.
    blocked: BTreeSet<Item>,
    /// Whether every publication reached the central host.
    offered: bool,
}

/// How often a round reads every owned folder, changed or not.
const FULL: Duration = Duration::from_secs(600);

/// What a scan of the design folders needs, off the async workers.
struct Scan {
    home: PathBuf,
}

impl Scan {
    fn folders(&self) -> Result<BTreeSet<Item>> {
        scan(&self.home.join("design"))
    }
}

fn rpc(e: RpcError) -> anyhow::Error {
    anyhow::anyhow!("{}: {}", e.code, e.message)
}

/// Every item whose folder is under the design folder `root`.
fn scan(root: &Path) -> Result<BTreeSet<Item>> {
    let mut out = BTreeSet::new();
    let Ok(workspaces) = std::fs::read_dir(root) else {
        return Ok(out);
    };
    for ws in workspaces.flatten() {
        let workspace = ws.file_name().to_string_lossy().into_owned();
        if workspace.starts_with('.') || !ws.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        for (kind, marker) in [(Kind::System, "config.toml"), (Kind::Design, "design.toml")] {
            let Ok(items) = std::fs::read_dir(ws.path().join(kind.folder())) else {
                continue;
            };
            for e in items.flatten() {
                let slug = e.file_name().to_string_lossy().into_owned();
                let real = e.file_type().is_ok_and(|t| t.is_dir())
                    && std::fs::symlink_metadata(e.path().join(marker)).is_ok_and(|m| m.is_file());
                if real && !slug.starts_with('.') {
                    out.insert(Item {
                        workspace: workspace.clone(),
                        kind,
                        slug,
                    });
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "7d3f1c2a";

    /// [`super::plan`] with no merged workspaces.
    fn plan(
        me: &str,
        records: &BTreeMap<String, Rec>,
        kept: &BTreeMap<String, Local>,
        folders: &BTreeSet<Item>,
    ) -> Vec<Step> {
        super::plan(me, records, kept, folders, &BTreeMap::new())
    }
    const MINI: &str = "studio-mini";

    fn acme() -> Item {
        Item::system("w-1", "acme-web")
    }

    fn rec(item: Item, owner: &str, tree: Option<&str>) -> Rec {
        Rec {
            item,
            name: "Acme web".into(),
            owner: owner.into(),
            tree: tree.map(String::from),
            agent: false,
        }
    }

    fn records(list: &[(&str, Rec)]) -> BTreeMap<String, Rec> {
        list.iter()
            .map(|(id, r)| (id.to_string(), r.clone()))
            .collect()
    }

    fn kept(list: &[(&str, Local)]) -> BTreeMap<String, Local> {
        list.iter()
            .map(|(id, l)| (id.to_string(), l.clone()))
            .collect()
    }

    fn folders(list: &[Item]) -> BTreeSet<Item> {
        list.iter().cloned().collect()
    }

    #[test]
    fn a_record_reads_its_fields_and_one_missing_its_owner_is_none() {
        let fields: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "workspace": "w-1", "kind": "design", "slug": "checkout", "name": "Checkout",
            "owner": MINI, "tree": "06441c7ba8234cb1db38b4de7e2351bbced1745d", "agent:studio-mini": true
        }))
        .unwrap();
        assert_eq!(
            Rec::parse(&fields),
            Some(Rec {
                item: Item::design("w-1", "checkout"),
                name: "Checkout".into(),
                owner: MINI.into(),
                tree: Some("06441c7ba8234cb1db38b4de7e2351bbced1745d".into()),
                agent: true,
            })
        );
        let mut no_owner = fields.clone();
        no_owner.remove("owner");
        assert_eq!(Rec::parse(&no_owner), None);
    }

    // Each member says only whether its own agent works: a former owner's
    // late "not working" never hides the new owner's agent.
    #[test]
    fn only_the_owners_own_agent_field_says_its_agent_works() {
        let fields = |extra: serde_json::Value| -> BTreeMap<String, Value> {
            let mut v = serde_json::json!({ "workspace": "w-1", "kind": "system", "slug": "acme-web", "owner": MINI });
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value(v).unwrap()
        };
        let agent = |extra| Rec::parse(&fields(extra)).unwrap().agent;
        assert!(agent(
            serde_json::json!({ "agent:studio-mini": true, "agent:7d3f1c2a": false })
        ));
        assert!(!agent(serde_json::json!({ "agent:7d3f1c2a": true })));
        assert!(!agent(serde_json::json!({ "agent": true })));
    }

    #[test]
    fn a_folder_no_record_names_is_claimed_and_one_in_another_members_place_moves_first() {
        let billing = Item::system("w-1", "billing");
        let steps = plan(
            ME,
            &records(&[("d-1", rec(acme(), MINI, Some("t1")))]),
            &kept(&[]),
            &folders(&[acme(), billing.clone()]),
        );
        assert_eq!(
            steps,
            vec![
                Step::Claim {
                    item: acme(),
                    rename: Some("acme-web-2".into())
                },
                Step::Claim {
                    item: billing,
                    rename: None
                },
                Step::Copy {
                    id: "d-1".into(),
                    item: acme(),
                    tree: "t1".into(),
                    from: None
                },
            ]
        );
    }

    #[test]
    fn an_owned_item_publishes_and_once_its_folder_is_gone_is_unpublished() {
        let records = records(&[("d-1", rec(acme(), ME, Some("t1")))]);
        let kept = kept(&[("d-1", Local::of(&acme(), Some("t1".into()), true))]);
        assert_eq!(
            super::plan(ME, &records, &kept, &folders(&[acme()]), &BTreeMap::new()),
            vec![Step::Publish {
                id: "d-1".into(),
                item: acme()
            }]
        );
        assert_eq!(
            plan(ME, &records, &kept, &folders(&[])),
            vec![Step::Unpublish { id: "d-1".into() }]
        );
    }

    #[test]
    fn a_copy_takes_a_newer_tree_follows_a_move_and_goes_with_its_record() {
        let moved = Item::system("w-2", "acme-web");
        let kept = kept(&[("d-1", Local::of(&acme(), Some("t1".into()), false))]);
        // Up to date: nothing to do.
        assert_eq!(
            plan(
                ME,
                &records(&[("d-1", rec(acme(), MINI, Some("t1")))]),
                &kept,
                &folders(&[acme()])
            ),
            vec![]
        );
        assert_eq!(
            plan(
                ME,
                &records(&[("d-1", rec(acme(), MINI, Some("t2")))]),
                &kept,
                &folders(&[acme()])
            ),
            vec![Step::Copy {
                id: "d-1".into(),
                item: acme(),
                tree: "t2".into(),
                from: None
            }]
        );
        assert_eq!(
            plan(
                ME,
                &records(&[("d-1", rec(moved.clone(), MINI, Some("t1")))]),
                &kept,
                &folders(&[acme()])
            ),
            vec![Step::Copy {
                id: "d-1".into(),
                item: moved,
                tree: "t1".into(),
                from: Some(acme())
            }]
        );
        // A copy removed by hand comes back.
        assert_eq!(
            plan(
                ME,
                &records(&[("d-1", rec(acme(), MINI, Some("t1")))]),
                &kept,
                &folders(&[])
            ),
            vec![Step::Copy {
                id: "d-1".into(),
                item: acme(),
                tree: "t1".into(),
                from: None
            }]
        );
        assert_eq!(
            plan(ME, &records(&[]), &kept, &folders(&[acme()])),
            vec![Step::Drop {
                id: "d-1".into(),
                item: acme(),
                owned: false
            }]
        );
    }

    #[test]
    fn an_item_another_member_moved_to_itself_is_lost_then_copied() {
        let kept = kept(&[("d-1", Local::of(&acme(), Some("t1".into()), true))]);
        assert_eq!(
            plan(
                ME,
                &records(&[("d-1", rec(acme(), MINI, Some("t1")))]),
                &kept,
                &folders(&[acme()])
            ),
            vec![
                Step::Lost {
                    id: "d-1".into(),
                    item: acme()
                },
                Step::Copy {
                    id: "d-1".into(),
                    item: acme(),
                    tree: "t1".into(),
                    from: None
                },
            ]
        );
    }

    #[test]
    fn a_copy_this_member_moved_to_itself_publishes() {
        let kept = kept(&[("d-1", Local::of(&acme(), Some("t1".into()), false))]);
        assert_eq!(
            plan(
                ME,
                &records(&[("d-1", rec(acme(), ME, Some("t1")))]),
                &kept,
                &folders(&[acme()])
            ),
            vec![Step::Publish {
                id: "d-1".into(),
                item: acme()
            }]
        );
    }

    #[test]
    fn two_records_in_one_place_keep_the_first_id_there_and_mine_moves_with_no_copy_meanwhile() {
        let records = records(&[
            ("d-1", rec(acme(), MINI, Some("t1"))),
            ("d-2", rec(acme(), ME, Some("t2"))),
        ]);
        let kept = kept(&[("d-2", Local::of(&acme(), Some("t2".into()), true))]);
        assert_eq!(
            super::plan(ME, &records, &kept, &folders(&[acme()]), &BTreeMap::new()),
            vec![Step::Rename {
                id: "d-2".into(),
                item: acme(),
                to: "acme-web-2".into()
            }]
        );
        // On a third member, neither is copied until the second moved.
        assert_eq!(
            super::plan(
                "air",
                &records,
                &BTreeMap::new(),
                &folders(&[]),
                &BTreeMap::new()
            ),
            vec![Step::Copy {
                id: "d-1".into(),
                item: acme(),
                tree: "t1".into(),
                from: None
            },]
        );
    }

    #[test]
    fn an_owned_item_of_a_merged_workspace_follows_its_folder_instead_of_going() {
        // w-1 merged into w-2, which had studio-mini's acme-web, so this
        // member's acme-web moved to acme-web-2.
        let theirs = Item::system("w-2", "acme-web");
        let moved = Item::system("w-2", "acme-web-2");
        let records = records(&[
            ("d-0", rec(theirs.clone(), MINI, Some("t0"))),
            ("d-1", rec(acme(), ME, Some("t1"))),
        ]);
        let kept = kept(&[
            ("d-0", Local::of(&theirs, Some("t0".into()), false)),
            ("d-1", Local::of(&acme(), Some("t1".into()), true)),
        ]);
        let merged = BTreeMap::from([("w-1".to_string(), "w-2".to_string())]);
        assert_eq!(
            super::plan(
                ME,
                &records,
                &kept,
                &folders(&[theirs, moved.clone()]),
                &merged
            ),
            vec![Step::Repoint {
                id: "d-1".into(),
                item: moved
            }]
        );
    }

    #[test]
    fn a_record_with_no_tree_yet_makes_no_copy() {
        assert_eq!(
            plan(
                ME,
                &records(&[("d-1", rec(acme(), MINI, None))]),
                &kept(&[]),
                &folders(&[])
            ),
            vec![]
        );
    }
}
