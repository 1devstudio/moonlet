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
    /// Whether the owner's agent is working on it.
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
            agent: fields
                .get("agent")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
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
) -> Vec<Step> {
    let mut steps = Vec::new();
    let tracked: BTreeSet<Item> = kept.values().map(Local::item).collect();
    let mut taken: BTreeSet<Item> = folders
        .iter()
        .cloned()
        .chain(records.values().map(|r| r.item.clone()))
        .collect();
    for item in folders.iter().filter(|i| !tracked.contains(i)) {
        let placed = records.values().find(|r| r.item == *item);
        match placed {
            // This member's own, its record already made: kept again.
            Some(r) if r.owner == me => continue,
            Some(_) => {
                let free = (2..)
                    .map(|n| Item {
                        slug: format!("{}-{n}", item.slug),
                        ..item.clone()
                    })
                    .find(|i| !taken.contains(i))
                    .expect("a free slug");
                taken.insert(free.clone());
                steps.push(Step::Claim {
                    item: item.clone(),
                    rename: Some(free.slug),
                });
            }
            None => steps.push(Step::Claim {
                item: item.clone(),
                rename: None,
            }),
        }
    }
    for (id, r) in records {
        let local = kept.get(id);
        if r.owner == me {
            if folders.contains(&r.item) {
                steps.push(Step::Publish {
                    id: id.clone(),
                    item: r.item.clone(),
                });
            } else {
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

    fn load(&self) -> BTreeMap<String, Local> {
        std::fs::read(self.copies_file())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
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
        self.load().into_iter().find(|(_, l)| l.item() == *item)
    }

    /// The account's records of items, by id.
    pub fn records(&self) -> BTreeMap<String, Rec> {
        self.sessions
            .design_records()
            .iter()
            .filter_map(|(id, fields)| Some((id.clone(), Rec::parse(fields)?)))
            .collect()
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
        let mut kept = self.load();
        let folders = {
            let me = self.clone_ref();
            tokio::task::spawn_blocking(move || me.folders()).await??
        };
        for step in plan(&me, &records, &kept, &folders) {
            let done = self.step(&me, &step, &records, &mut kept).await;
            if let Err(e) = done {
                tracing::warn!(?step, "design copies: {e:#}");
            }
            self.save(&kept)?;
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
        me: &str,
        step: &Step,
        records: &BTreeMap<String, Rec>,
        kept: &mut BTreeMap<String, Local>,
    ) -> Result<()> {
        match step {
            Step::Claim { item, rename } => {
                let item = match rename {
                    Some(_) => {
                        let store = self.store.clone();
                        let (ws, kind, slug) = (
                            item.workspace.clone(),
                            item.kind.folder(),
                            item.slug.clone(),
                        );
                        // Only this member's own designs follow its renamed system.
                        let copies: BTreeSet<String> = kept
                            .values()
                            .filter(|l| !l.owned && l.workspace == ws && l.kind == "design")
                            .map(|l| l.slug.clone())
                            .collect();
                        let to = tokio::task::spawn_blocking(move || {
                            store.rename_item(&ws, kind, &slug, &|d| !copies.contains(d))
                        })
                        .await??;
                        Item {
                            slug: to,
                            ..item.clone()
                        }
                    }
                    None => item.clone(),
                };
                let id = format!("d-{}", uuid::Uuid::new_v4().simple());
                let name = self.name_of(&item).unwrap_or_default();
                self.sessions.set_design(
                    &id,
                    &[
                        ("workspace", json!(item.workspace)),
                        ("kind", json!(item.kind.as_str())),
                        ("slug", json!(item.slug)),
                        ("name", json!(name)),
                        ("owner", json!(me)),
                    ],
                );
                kept.insert(id.clone(), Local::of(&item, None, true));
                self.publish(&id, &item, None, kept).await
            }
            Step::Publish { id, item } => {
                let had = kept.get(id).and_then(|l| l.tree.clone());
                kept.insert(id.clone(), Local::of(item, had, true));
                let published = records.get(id).and_then(|r| r.tree.clone());
                self.publish(id, item, published, kept).await?;
                let busy = self.busy.lock().unwrap().as_ref().is_some_and(|f| f(item));
                if records.get(id).is_some_and(|r| r.agent != busy) {
                    self.sessions.set_design(id, &[("agent", json!(busy))]);
                }
                Ok(())
            }
            Step::Unpublish { id } => {
                self.sessions.delete_design(id);
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
                self.fetch(tree, kept).await?;
                if let Some(from) = from {
                    self.remove_folder(from).await?;
                }
                let projects = self.sessions.list_projects();
                let locate = move |identity: &moonlet_proto::types::ProjectIdentity| {
                    projects
                        .iter()
                        .find(|p| moonlet_core::identity::same_project(&p.identity, identity))
                        .map(|p| (p.id.clone(), p.path.clone()))
                };
                self.replicas.apply(item, tree, &locate).await?;
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

    /// Snapshots an item this member owns and, when the tree changed,
    /// publishes it: a member first sends the central host the objects it
    /// lacks, so a member reading the record can always fetch the tree.
    async fn publish(
        &self,
        id: &str,
        item: &Item,
        published: Option<String>,
        kept: &mut BTreeMap<String, Local>,
    ) -> Result<()> {
        let tree = self.replicas.snapshot(item).await?;
        if published.as_deref() != Some(tree.as_str()) {
            if self.link.central_name().is_some() {
                let host = self
                    .link
                    .host()
                    .context("the central host is not connected")?;
                let have: Vec<String> = published.into_iter().collect();
                let pack = self.replicas.pack(&tree, &have).await?;
                let pack = if pack.is_empty() {
                    None
                } else {
                    Some(host.send_pack(&pack).map_err(rpc)?)
                };
                host.request(
                    m::DESIGN_OFFER,
                    serde_json::to_value(m::DesignOffer {
                        tree: tree.clone(),
                        pack,
                    })?,
                )
                .await
                .map_err(rpc)?;
            }
            let name = self.name_of(item).unwrap_or_default();
            self.sessions
                .set_design(id, &[("tree", json!(tree)), ("name", json!(name))]);
        }
        if let Some(l) = kept.get_mut(id) {
            l.tree = Some(tree);
        }
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

    /// Moves this member's items of merged workspace `from` into `into`
    /// (X68): its own move with the folder, under their new place; its
    /// copies go, as their owners move them.
    pub async fn before_merge(&self, from: &str) -> Result<()> {
        let _one = self.round.lock().await;
        let mut kept = self.load();
        let copies: Vec<(String, Item)> = kept
            .iter()
            .filter(|(_, l)| !l.owned && l.workspace == from)
            .map(|(id, l)| (id.clone(), l.item()))
            .collect();
        for (id, item) in copies {
            self.remove_folder(&item).await?;
            kept.remove(&id);
        }
        self.save(&kept)
    }

    /// After a merge moved this member's own items (`moved`, from workspace
    /// `from` into `into`): their records name their new place.
    pub fn after_merge(
        &self,
        from: &str,
        into: &str,
        moved: &[moonlet_core::design::merge::Moved],
    ) -> Result<()> {
        let mut kept = self.load();
        for mv in moved {
            let kind = if mv.kind == "system" {
                "system"
            } else {
                "design"
            };
            let Some((id, l)) = kept.iter_mut().find(|(_, l)| {
                l.owned && l.workspace == from && l.kind == kind && l.slug == mv.from
            }) else {
                continue;
            };
            l.workspace = into.to_string();
            l.slug = mv.to.clone();
            self.sessions
                .set_design(id, &[("workspace", json!(into)), ("slug", json!(mv.to))]);
        }
        self.save(&kept)
    }
}

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
            "owner": MINI, "tree": "06441c7ba8234cb1db38b4de7e2351bbced1745d", "agent": true
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
            plan(ME, &records, &kept, &folders(&[acme()])),
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
