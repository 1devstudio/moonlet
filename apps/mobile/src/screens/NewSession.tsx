// New session (X40): a prompt, where it runs, and how much the agent may do
// alone; Start session creates the worktree and opens its chat.

import { type ReactNode, useEffect, useState } from "react";
import { ArrowRight, Check, ChevronRight, Mic } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { latestOnly } from "@desktop/lib/prStack";
import { CLAUDE_MODELS, EFFORTS } from "@desktop/lib/agents";
import { M, type ProjectConfig, type Session } from "@desktop/lib/protocol";
import { loadHost, showScreen, showTab, useApp } from "../lib/app";
import { MODES, branchPreview, modeHelp, projectChoices, setupLine } from "../lib/newSession";
import { AgentIcon, Btn, cx } from "../components/ui";
import { Sheet } from "../components/Sheet";

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

type Picker = "project" | "agent" | "model" | "base" | null;

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = choices[Math.min(pick, choices.length - 1)];
  const [latest] = useState(latestOnly);

  useEffect(() => {
    if (!choice) return;
    setBase(null);
    setConfig(null);
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

  const start = async () => {
    if (!choice || busy || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const s = await rpc<Session>(choice.host, M.sessionCreate, {
        project_id: choice.project.id,
        prompt: prompt.trim(),
        agent,
        model: agent === "claude" ? model : null,
        effort: agent === "claude" ? effort : null,
        mode: agent === "claude" ? mode : null,
        from: base && base !== choice.project.base_branch ? base : null,
        workspace_id: choice.workspaceId,
        cols: 80,
        rows: 32,
      });
      await loadHost(choice.host).catch(() => {});
      setPrompt("");
      showScreen({ kind: "session", host: choice.host, id: s.id, tab: "chat" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
              <div className="flex flex-col rounded-[14px] border border-border-strong bg-panel">
                <textarea id="task" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the task…" className="resize-none bg-transparent p-3.5 text-[15px] leading-[1.45] outline-none" />
                <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
                  <button type="button" aria-label="Dictate" onClick={() => document.getElementById("task")?.focus()} className="flex h-9 w-9 items-center justify-center text-muted">
                    <Mic size={18} />
                  </button>
                  <span className="flex-1" />
                  <span className="truncate pr-2 font-mono text-[12px] text-faint">{branchPreview(prompt)}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-col rounded-[14px] border border-border bg-panel">
              <RowButton label="Project" value={choice.project.name} onClick={() => setPicker("project")} />
              <RowButton label="Host" value={choice.hostLabel} hint={hosts[choice.host]?.status === "connected" ? "online" : "offline"} onClick={() => setPicker("project")} />
              <RowButton label="Agent" value={AGENTS.find((a) => a.id === agent)?.label ?? agent} icon={<AgentIcon agent={agent} size={14} />} onClick={() => setPicker("agent")} />
              {agent === "claude" && <RowButton label="Model" value={modelLabel} hint={`${effortLabel} effort`} onClick={() => setPicker("model")} />}
              <RowButton label="Base" value={baseName} mono onClick={() => setPicker("base")} />
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
          <span className="text-[12.5px] text-muted">{setupLine(baseName, choice.hostLabel, config?.setup)}</span>
          {error && <span className="text-[12.5px] text-error">{error}</span>}
          <Btn tone="primary" disabled={busy || !prompt.trim()} onClick={() => void start()}>
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
