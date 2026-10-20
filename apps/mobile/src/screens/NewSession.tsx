// New session (X40): a prompt, where it runs, and how much the agent may do
// alone; Start session creates the worktree and opens its chat.

import { type ReactNode, useEffect, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronRight, FileText, GitBranch, GitPullRequest, Mic, Search, X } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { latestOnly } from "@desktop/lib/prStack";
import { CLAUDE_MODELS, EFFORTS } from "@desktop/lib/agents";
import { type IssueRef, M, type Project, type ProjectConfig, type Session } from "@desktop/lib/protocol";
import { type Attachment, type PickerList, type PickerTab, pickerBranches, pickerHint, pickerSearch } from "@desktop/lib/composer";
import { loadHost, showScreen, showTab, useApp } from "../lib/app";
import { MODES, branchPrefix, composer, modeHelp, projectChoices, setupLine } from "../lib/newSession";
import { useBusy } from "../lib/busy";
import { AgentIcon, Btn, cx } from "../components/ui";
import { Sheet } from "../components/Sheet";
import { Markdown } from "../components/Markdown";

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

type Picker = "project" | "agent" | "model" | "base" | "source" | null;

function RowButton({ label, value, hint, onClick, icon, mono }: { label: string; value: string; hint?: string; onClick: () => void; icon?: ReactNode; mono?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-[50px] items-center gap-2.5 border-b border-border px-3.5 text-left last:border-b-0">
      <span className="w-[72px] text-[14px] text-muted">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {icon}
        <span className={cx("truncate text-[15px]", mono && "font-mono text-[14px]")}>{value}</span>
        {hint && <span className="truncate text-[12.5px] text-faint">{hint}</span>}
      </span>
      <ChevronRight size={16} className="text-faint" />
    </button>
  );
}

function Choices<T extends string>({ items, current, onPick }: { items: { id: T; label: string; hint?: string }[]; current: T | null; onPick: (id: T) => void }) {
  return (
    <div className="scroll flex flex-col px-2 pb-2">
      {items.map((i) => (
        <button key={i.id} type="button" onClick={() => onPick(i.id)} className="flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px]">{i.label}</span>
            {i.hint && <span className="truncate text-[12.5px] text-faint">{i.hint}</span>}
          </span>
          {i.id === current && <Check size={16} className="text-accent" />}
        </button>
      ))}
    </div>
  );
}

/** The branches and GitHub pull requests to start from (X54), searched by name, or by number and title. */
function SourceSheet({ host, project, base, onBranch, onPr, onClose }: { host: string; project: Project; base: string; onBranch: (b: string) => void; onPr: (p: IssueRef) => void; onClose: () => void }) {
  const [tab, setTab] = useState<PickerTab>("branch");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setItems(null);
    setError(null);
    // A list that arrives after a switch to the other tab is dropped.
    let current = true;
    const load: Promise<PickerList> =
      tab === "branch"
        ? rpc<string[]>(host, M.gitBranches, { path: project.path }).then((list) => ({ tab, list: pickerBranches(list) }))
        : rpc<IssueRef[]>(host, M.ghPrs, { path: project.path }).then((list) => ({ tab, list }));
    void load.then((got) => current && setItems(got)).catch((e) => current && setError(String(e?.message ?? e)));
    return () => {
      current = false;
    };
  }, [tab, host, project.path]);
  const found = items && pickerSearch(items, q);
  return (
    <Sheet label="Start from a branch or PR" onClose={onClose}>
      <div className="flex flex-col gap-2 px-4 pb-1">
        <div className="grid grid-cols-2 rounded-[10px] bg-raised p-[3px]">
          {(["branch", "pr"] as const).map((t) => (
            <button key={t} type="button" onClick={() => (setTab(t), setQ(""))} className={cx("h-9 rounded-[8px] text-[13.5px]", tab === t ? "bg-border-strong font-semibold text-fg" : "text-muted")}>
              {t === "branch" ? "Branches" : "Pull requests"}
            </button>
          ))}
        </div>
        <label className="flex h-10 items-center gap-2 rounded-[10px] border border-border-strong bg-bg px-3">
          <Search size={15} className="text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === "branch" ? "Search by name" : "Search by number or title"} className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none" />
        </label>
      </div>
      <div className="scroll flex min-h-[200px] flex-col px-2">
        {error ? (
          <p className="px-3 py-2 text-[13.5px] text-error">{error}</p>
        ) : !found ? (
          <p className="px-3 py-2 text-[13.5px] text-muted">Loading…</p>
        ) : !found.list.length ? (
          <p className="px-3 py-2 text-[13.5px] text-muted">{q ? "Nothing matches." : found.tab === "branch" ? "No branches." : "No open pull requests."}</p>
        ) : found.tab === "branch" ? (
          found.list.map((b) => (
            <button key={b} type="button" onClick={() => onBranch(b)} className="flex min-h-12 items-center gap-2.5 rounded-[10px] px-3 text-left">
              <GitBranch size={15} className="flex-none text-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-[14px]">{b}</span>
            </button>
          ))
        ) : (
          found.list.map((i) => (
            <button key={i.number} type="button" onClick={() => onPr(i)} className="flex min-h-12 items-center gap-2.5 rounded-[10px] px-3 text-left">
              <span className="w-12 flex-none font-mono text-[13px] text-faint">#{i.number}</span>
              <span className="min-w-0 flex-1 truncate text-[15px]">{i.title}</span>
            </button>
          ))
        )}
      </div>
      <p className="px-5 pt-1 text-[12px] leading-snug text-faint">{pickerHint(tab, null, base)}</p>
    </Sheet>
  );
}

/** A folded attachment above the prompt (X54); a tap shows what it sends. */
function AttachmentCard({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const Icon = a.icon === "pr" ? GitPullRequest : FileText;
  return (
    <div className="flex flex-col rounded-[10px] border border-border bg-raised">
      <div className="flex min-h-11 items-center gap-2 pr-1 pl-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13.5px]">
          <Icon size={14} className="flex-none text-muted" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted">{a.lead}</span>
            {a.summary}
          </span>
          {open ? <ChevronDown size={14} className="flex-none text-faint" /> : <ChevronRight size={14} className="flex-none text-faint" />}
        </button>
        {a.remove && (
          <button type="button" aria-label={a.remove} onClick={onRemove} className="flex h-9 w-9 flex-none items-center justify-center text-faint">
            <X size={15} />
          </button>
        )}
      </div>
      {open && a.body && (
        <div className="scroll max-h-56 border-t border-border px-3 py-2 text-[13px]">
          <Markdown text={a.body} />
        </div>
      )}
    </div>
  );
}

export function NewSessionScreen() {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useApp((s) => s.settings.workspace);
  const choices = projectChoices(hosts, data, workspace);
  const [prompt, setPrompt] = useState("");
  const [pick, setPick] = useState(0);
  const [agent, setAgent] = useState("claude");
  const [model, setModel] = useState("opus");
  const [effort, setEffort] = useState("high");
  const [mode, setMode] = useState("manual");
  const [base, setBase] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  // A branch or GitHub PR to start from (X54); a PR's reviews once read.
  const [picked, setPicked] = useState<string | null>(null);
  const [pr, setPr] = useState<IssueRef | null>(null);
  const [prContext, setPrContext] = useState<string | null>(null);
  const [prSend, setPrSend] = useState(true);
  const [prLatest] = useState(latestOnly);
  const { busy, error, run } = useBusy();
  const choice = choices[Math.min(pick, choices.length - 1)];
  const [latest] = useState(latestOnly);

  useEffect(() => {
    if (!choice) return;
    setBase(null);
    setConfig(null);
    setPicked(null);
    setPr(null);
    setBranches([]);
    // A reply for a project picked before this one is dropped.
    const isLatest = latest.start();
    void rpc<ProjectConfig>(choice.host, M.projectConfig, { id: choice.project.id })
      .then((c) => isLatest() && setConfig(c))
      .catch(() => isLatest() && setConfig(null));
    void rpc<string[]>(choice.host, M.gitBranches, { path: choice.project.path })
      .then((b) => isLatest() && setBranches(b))
      .catch(() => isLatest() && setBranches([]));
  }, [choice?.host, choice?.project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The host's Git settings (X55) name the branch and say where it starts.
  const git = choice ? (data[choice.host]?.git ?? null) : null;
  const c = composer({ typed: prompt, prefix: branchPrefix(config, git), pickedBranch: picked, pr, prContext, prSend, base, projectBase: choice?.project.base_branch ?? "main", startFrom: git?.start_from ?? "local" });
  const pickPr = (p: IssueRef) => {
    setPr(p);
    setPrSend(true);
    setPrContext(null);
    setBase(null);
    setPicked(null);
    setPicker(null);
    if (!choice) return;
    // Its reviews and comments; the list's description until they are read.
    const isLatest = prLatest.start();
    void rpc<string>(choice.host, M.ghPrContext, { path: choice.project.path, number: p.number })
      .then((text) => isLatest() && setPrContext(text))
      .catch(() => {});
  };

  const start = async () => {
    if (!choice || busy || !c.create) return;
    const create = c.create;
    await run(async () => {
      const s = await rpc<Session>(choice.host, M.sessionCreate, {
        project_id: choice.project.id,
        prompt: create.prompt,
        name: create.name,
        pr: create.pr,
        from: create.from,
        branch: create.branch,
        existing_branch: create.branch !== null,
        agent,
        model: agent === "claude" ? model : null,
        effort: agent === "claude" ? effort : null,
        mode: agent === "claude" ? mode : null,
        workspace_id: choice.workspaceId,
        cols: 80,
        rows: 32,
      });
      await loadHost(choice.host).catch(() => {});
      setPrompt("");
      setPicked(null);
      setPr(null);
      showScreen({ kind: "session", host: choice.host, id: s.id, tab: "chat" });
    });
  };

  const baseName = base ?? choice?.project.base_branch ?? "main";
  const modelLabel = CLAUDE_MODELS.find((m) => m.id === model)?.label ?? model;
  const effortLabel = EFFORTS.find((e) => e.id === effort)?.label ?? effort;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center px-4 pb-2" style={{ paddingTop: "calc(var(--safe-top) + 10px)" }}>
        <button type="button" onClick={() => showTab("inbox")} className="text-[15px] text-accent-2">
          Cancel
        </button>
        <span className="flex-1 text-center text-[16px] font-semibold">New session</span>
        <span className="w-[52px]" />
      </div>
      <div className="scroll flex min-h-0 flex-1 flex-col gap-4 px-4 pt-2 pb-4">
        {!choice ? (
          <p className="text-[14px] text-muted">No project in this workspace yet. Add one in the desktop app.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor="task" className="text-[13px] text-muted">
                What do you want to work on?
              </label>
              {c.attachments.map((a) => (
                <AttachmentCard key={a.id} a={a} onRemove={() => setPrSend(false)} />
              ))}
              <div className="flex flex-col rounded-[14px] border border-border-strong bg-panel">
                <textarea id="task" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={c.attachments.length ? c.placeholder : "Describe the task…"} className="resize-none bg-transparent p-3.5 text-[15px] leading-[1.45] outline-none" />
                <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
                  <button type="button" aria-label="Dictate" onClick={() => document.getElementById("task")?.focus()} className="flex h-9 w-9 items-center justify-center text-muted">
                    <Mic size={18} />
                  </button>
                  <span className="flex-1" />
                  <span className="truncate pr-2 font-mono text-[12px] text-faint">
                    {c.branch.name}
                    {c.branch.existing && <span className="font-sans"> · existing branch</span>}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex flex-col rounded-[14px] border border-border bg-panel">
              <RowButton label="Project" value={choice.project.name} onClick={() => setPicker("project")} />
              <RowButton
                label="Work on"
                value={pr ? `PR #${pr.number}` : (picked ?? "Branch or pull request")}
                hint={pr || picked ? undefined : "optional"}
                mono={!pr && !!picked}
                onClick={() => setPicker("source")}
              />
              <RowButton label="Host" value={choice.hostLabel} hint={hosts[choice.host]?.status === "connected" ? "online" : "offline"} onClick={() => setPicker("project")} />
              <RowButton label="Agent" value={AGENTS.find((a) => a.id === agent)?.label ?? agent} icon={<AgentIcon agent={agent} size={14} />} onClick={() => setPicker("agent")} />
              {agent === "claude" && <RowButton label="Model" value={modelLabel} hint={`${effortLabel} effort`} onClick={() => setPicker("model")} />}
              {!pr && !picked && <RowButton label="Base" value={baseName} mono onClick={() => setPicker("base")} />}
            </div>
            {agent === "claude" && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-muted">Mode</span>
                <div className="grid grid-cols-4 rounded-[10px] bg-panel p-[3px]">
                  {MODES.map((m) => (
                    <button key={m.id} type="button" onClick={() => setMode(m.id)} className={cx("h-9 rounded-[8px] text-[13.5px]", mode === m.id ? "bg-border-strong font-semibold text-fg" : "text-muted")}>
                      {m.label}
                    </button>
                  ))}
                </div>
                <span className="text-[12.5px] leading-snug text-faint">{modeHelp(mode)}</span>
              </div>
            )}
          </>
        )}
      </div>
      {choice && (
        <div className="flex flex-col gap-2.5 border-t border-border px-4 pt-3 pb-3">
          <span className="text-[12.5px] text-muted">{setupLine(c.start, choice.hostLabel, config?.setup)}</span>
          {error && <span className="text-[12.5px] text-error">{error}</span>}
          <Btn tone="primary" disabled={busy || !c.create} onClick={() => void start()}>
            {busy ? "Starting…" : "Start session"} <ArrowRight size={16} />
          </Btn>
        </div>
      )}

      {picker === "project" && (
        <Sheet label="Project" onClose={() => setPicker(null)}>
          <Choices
            items={choices.map((c, i) => ({ id: String(i), label: c.project.name, hint: c.hostLabel }))}
            current={String(Math.min(pick, choices.length - 1))}
            onPick={(i) => {
              setPick(Number(i));
              setPicker(null);
            }}
          />
        </Sheet>
      )}
      {picker === "agent" && (
        <Sheet label="Agent" onClose={() => setPicker(null)}>
          <Choices items={AGENTS} current={agent} onPick={(a) => (setAgent(a), setPicker(null))} />
        </Sheet>
      )}
      {picker === "model" && (
        <Sheet label="Model" onClose={() => setPicker(null)}>
          <div className="eyebrow px-5 pt-1">Model</div>
          <Choices items={CLAUDE_MODELS} current={model} onPick={setModel} />
          <div className="eyebrow px-5">Effort</div>
          <Choices items={EFFORTS} current={effort} onPick={(e) => (setEffort(e), setPicker(null))} />
        </Sheet>
      )}
      {picker === "source" && choice && (
        <SourceSheet
          host={choice.host}
          project={choice.project}
          base={choice.project.base_branch}
          onBranch={(b) => (setPicked(b), setPr(null), setBase(null), setPicker(null))}
          onPr={pickPr}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "base" && choice && (
        <Sheet label="Base" onClose={() => setPicker(null)}>
          <Choices
            items={[choice.project.base_branch, ...branches.filter((b) => b !== choice.project.base_branch)].map((b) => ({ id: b, label: b }))}
            current={baseName}
            onPick={(b) => (setBase(b), setPicker(null))}
          />
        </Sheet>
      )}
    </div>
  );
}
