// Settings › App (X43): General, Appearance, Terminal, Agents and
// Notifications. Every control saves as soon as it changes.

import { useEffect, useId, useState } from "react";
import { Play } from "lucide-react";
import { askConfirm } from "../../lib/confirm";
import { hostsApi } from "../../lib/daemon";
import { checkClaudeVersion, checkForUpdates, errorToast, toast, updateActions, updateClaude, updateSettings, useStore } from "../../lib/store";
import { updateButton } from "../../lib/updater";
import { claudeOffer } from "../../lib/claudeUpdate";
import { CLAUDE_MODES, PLAN_APPROVE_MODES, resolveMode, resolvePlanMode } from "../../lib/agents";
import type { ToolCallView } from "../../lib/chat";
import { DEFAULT_SOUNDS, SOUND_EVENTS, SYSTEM_SOUNDS, soundFor } from "../../lib/sounds";
import { bannerOn } from "../../lib/alerts";
import { EDITOR_THEMES, resolveEditorTheme } from "../../lib/editorThemes";
import { MAX_FONT_SIZE, MIN_FONT_SIZE, stepFontSize } from "../../lib/uiScale";
import { appUpdateLine, claudeUpdateLine, daemonLine } from "../../lib/settingsPage";
import { Button, IconButton, StateGlyph, cx } from "../ui";
import { Card, PageHeading, RadioList, Row, Section, Segmented, Status, SwitchRow, fieldCls, radioProps } from "./controls";
import { ThemeSample } from "./ThemeSample";
import { ROW_STYLES, rowStyle } from "../../lib/sessionRows";
import { SessionRowsPreview } from "../Sidebar";

const go = (page: "appearance") => useStore.setState({ settingsPage: { page } });

/** The running version, a manual check and the automatic one (X35, X36). */
function Updates() {
  const version = useStore((s) => s.appVersion);
  const update = useStore((s) => s.update);
  const checking = useStore((s) => s.updateChecking);
  const error = useStore((s) => s.updateError);
  const auto = useStore((s) => s.settings.autoUpdateCheck);
  const claude = useStore((s) => s.claudeUpdate);
  const versions = useStore((s) => s.claudeVersions);
  const claudeChecking = useStore((s) => s.claudeChecking);
  const status = appUpdateLine(update, checking, error);
  const b = updateButton(update);
  const cStatus = claudeUpdateLine(claude, versions, claudeChecking);
  const offer = claudeOffer(claude, versions);
  // Before the first automatic check, ten seconds after launch.
  useEffect(() => {
    if (!versions.installed && !versions.latest) void checkClaudeVersion();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Section title="Updates">
      <Card>
        <Row
          setting="updates"
          label={
            <>
              moonlet <span className="font-mono ui-text-12.5">{version ?? "…"}</span>
            </>
          }
          hint={status && <Status line={status} />}
        >
          <span className="flex gap-2">
            {b?.action && (
              <Button size="sm" variant="primary" title={b.title} onClick={updateActions[b.action]}>
                {b.label}
              </Button>
            )}
            <Button
              size="sm"
              disabled={checking}
              onClick={() => {
                void checkForUpdates({ manual: true });
                void checkClaudeVersion();
              }}
            >
              Check now
            </Button>
          </span>
        </Row>
        <Row
          setting="claude-update"
          label={
            <>
              Claude Code <span className="font-mono ui-text-12.5">{versions.installed ?? "…"}</span>
            </>
          }
          hint={cStatus && <Status line={cStatus} />}
        >
          {offer && (
            <Button size="sm" variant="primary" onClick={() => void updateClaude()}>
              Update to {offer}
            </Button>
          )}
        </Row>
        <SwitchRow
          setting="auto-update"
          label="Check for updates automatically"
          hint="At launch and every six hours, for both moonlet and Claude Code."
          on={auto}
          onChange={(on) => updateSettings({ autoUpdateCheck: on })}
        />
      </Card>
    </Section>
  );
}

/** Start moonletd at login under launchd (S1b). */
function Daemon() {
  const [status, setStatus] = useState<{ installed: boolean; loaded: boolean; plist: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const home = useStore((s) => s.hosts.local?.home ?? null);
  useEffect(() => {
    void hostsApi.service("status").then(setStatus).catch(() => setStatus(null));
  }, []);
  const toggle = async (on: boolean) => {
    if (!on && status?.loaded) {
      const ok = await askConfirm({
        title: "Stop the background daemon",
        message: "Turning this off stops the daemon that launchd is running. Terminals and agents it holds may end. Turn it off?",
        action: "Turn off",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      setStatus(await hostsApi.service(on ? "install" : "uninstall"));
      toast(on ? "The moonlet daemon now starts at login" : "Login item removed");
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Background daemon">
      <Card>
        <SwitchRow
          setting="daemon"
          label="Start the moonlet daemon at login"
          hint="Agents run in moonletd, not in this window. Under launchd it starts at login and restarts if it ever crashes."
          on={!!status?.installed}
          disabled={busy || !status}
          onChange={(on) => void toggle(on)}
        />
        {status && (
          <div className="px-4 py-2.5">
            <Status line={daemonLine(status, home)} />
          </div>
        )}
      </Card>
    </Section>
  );
}

export function GeneralPage() {
  return (
    <>
      <PageHeading title="General">Versions and updates, and how moonlet's background daemon starts.</PageHeading>
      <Updates />
      <Daemon />
    </>
  );
}

export function AppearancePage() {
  const term = useStore((s) => s.settings.term);
  const rows = useStore((s) => rowStyle(s.settings.sessionRows));
  const rowsId = useId();
  const pickRows = (i: number) => updateSettings({ sessionRows: ROW_STYLES[i].id });
  const theme = useStore((s) => resolveEditorTheme(s.settings.editorTheme));
  const setSize = (fontSize: number) => updateSettings({ term: { ...term, fontSize } });
  // Typed digits apply on Enter or when the field is left, kept in range.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) setSize(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n)));
    setDraft(null);
  };
  return (
    <>
      <PageHeading title="Appearance">Text size across the app, how session rows show their task, and the colours of files and diffs.</PageHeading>
      <Section title="Text">
        <Card>
          <Row setting="font-size" label="Font size" htmlFor="settings-font-size" hint="Scales all of moonlet's text. Terminals use this size too.">
            <div className="flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border-strong bg-panel-2">
              <button type="button" aria-label="Smaller" className="w-7 text-muted hover:bg-hover hover:text-fg disabled:opacity-40" disabled={term.fontSize <= MIN_FONT_SIZE} onClick={() => setSize(stepFontSize(term.fontSize, -1))}>
                −
              </button>
              <input
                id="settings-font-size"
                type="number"
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                value={draft ?? term.fontSize}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => e.key === "Enter" && commit()}
                className="w-10 border-x border-border-strong bg-transparent text-center ui-text-12.5 text-fg outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button type="button" aria-label="Larger" className="w-7 text-muted hover:bg-hover hover:text-fg disabled:opacity-40" disabled={term.fontSize >= MAX_FONT_SIZE} onClick={() => setSize(stepFontSize(term.fontSize, 1))}>
                +
              </button>
            </div>
          </Row>
          <div aria-label="Sample text" role="group" className="flex items-baseline gap-4 px-4 py-3">
            <span className="ui-text-13.5">Add search to the product list</span>
            <span className="font-mono ui-text-13 text-muted">pnpm test --filter web</span>
          </div>
        </Card>
      </Section>
      <section aria-labelledby={rowsId} className="flex flex-col gap-2.5" data-setting="session-rows">
        <h2 id={rowsId} className="m-0 px-0.5 ui-text-11.5 font-semibold uppercase tracking-[0.08em] text-muted">
          Session rows
        </h2>
        <div role="radiogroup" aria-labelledby={rowsId} className="flex gap-2.5">
          {ROW_STYLES.map((o, i) => (
            <button
              key={o.id}
              type="button"
              {...radioProps(i, ROW_STYLES.findIndex((x) => x.id === rows), ROW_STYLES.length, pickRows)}
              className={cx("flex min-w-0 flex-1 flex-col items-stretch gap-2.5 rounded-[10px] border px-4 py-3.5 text-left", rows === o.id ? "border-accent bg-selected" : "border-border bg-panel hover:bg-panel-2")}
            >
              <span className="flex flex-col gap-1">
                <span className="ui-text-13">{o.label}</span>
                <span className="ui-text-12 text-muted">{o.hint}</span>
              </span>
              <SessionRowsPreview style={o.id} />
            </button>
          ))}
        </div>
        <span className="px-0.5 ui-text-12 text-muted">How a session in the sidebar shows the task it works on. Right-click a session to link it to a task.</span>
      </section>
      <Section title="Editor and diffs">
        <Card>
          <Row setting="editor-theme" label="Colour theme of files and diffs" htmlFor="settings-theme" hint="Syntax colours in editor tabs and the Changes diff.">
            <select id="settings-theme" className={cx(fieldCls, "w-[200px]")} value={theme} onChange={(e) => updateSettings({ editorTheme: e.target.value })}>
              {EDITOR_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="px-4 py-3.5">
            <ThemeSample theme={theme} />
          </div>
        </Card>
      </Section>
    </>
  );
}

/** One of the two New shells cards. */
function ShellCard({ on, title, badge, children, radio }: { on: boolean; title: string; badge?: string; children: string; radio: ReturnType<typeof radioProps> }) {
  return (
    <button
      type="button"
      {...radio}
      className={cx("flex flex-1 flex-col items-start gap-1.5 rounded-[10px] border px-4 py-3.5 text-left", on ? "border-accent bg-selected" : "border-border bg-panel hover:bg-panel-2")}
    >
      <span className="flex items-center gap-2 ui-text-13">
        {title}
        {badge && <span className="ui-text-11.5 text-faint">{badge}</span>}
      </span>
      <span className="ui-text-12 text-muted">{children}</span>
    </button>
  );
}

export function TerminalPage() {
  const t = useStore((s) => s.settings.term);
  const setTerm = (patch: Partial<typeof t>) => updateSettings({ term: { ...t, ...patch } });
  const shells = useId();
  const pickShell = (i: number) => setTerm({ classicPrompt: i === 1 });
  return (
    <>
      <PageHeading title="Terminal">
        Shell and run terminals. The font size is under{" "}
        <button type="button" className="text-accent-2 hover:text-accent" onClick={() => go("appearance")}>
          Appearance
        </button>
        , as it scales the whole app.
      </PageHeading>
      <Section title="Font">
        <Card>
          <div data-setting="font-family" className="flex flex-col gap-2 px-4 py-3.5">
            <label htmlFor="settings-font-family" className="ui-text-13">
              Font family
            </label>
            <input id="settings-font-family" spellCheck={false} className={cx(fieldCls, "font-mono")} value={t.fontFamily} onChange={(e) => setTerm({ fontFamily: e.target.value })} />
            <span className="ui-text-12 text-muted">A CSS font list; the first one installed wins.</span>
          </div>
        </Card>
      </Section>
      <section aria-labelledby={shells} className="flex flex-col gap-2.5" data-setting="new-shells">
        <h2 id={shells} className="m-0 px-0.5 ui-text-11.5 font-semibold uppercase tracking-[0.08em] text-muted">
          New shells
        </h2>
        <div role="radiogroup" aria-labelledby={shells} className="flex gap-2.5">
          <ShellCard on={!t.classicPrompt} title="Blocks" badge="default" radio={radioProps(0, t.classicPrompt ? 1 : 0, 2, pickShell)}>
            The input editor at the bottom, each command shown as a block with its output, exit status and time.
          </ShellCard>
          <ShellCard on={t.classicPrompt} title="Classic" radio={radioProps(1, t.classicPrompt ? 1 : 0, 2, pickShell)}>
            The shell keeps its own prompt and you type into the terminal. No input editor.
          </ShellCard>
        </div>
        <span className="px-0.5 ui-text-12 text-muted">Applies to shells opened from now on. A running shell keeps its mode.</span>
      </section>
      <Section title="Keyboard and clipboard">
        <Card>
          <SwitchRow setting="option-meta" label="Use Option as Meta" hint="⌥B, ⌥F and friends move by word in shells and Emacs-style programs." on={t.optionIsMeta} onChange={(on) => setTerm({ optionIsMeta: on })} />
          <SwitchRow
            setting="osc52"
            label="Let programs write to the clipboard"
            hint="OSC 52, as used by tmux and Neovim over SSH. Any program in a terminal could then replace what you copied."
            on={t.allowOsc52}
            onChange={(on) => setTerm({ allowOsc52: on })}
          />
        </Card>
      </Section>
      <Section title="Rendering">
        <Card>
          <SwitchRow setting="webgl" label="GPU rendering" hint="Draws terminals with WebGL. Off, they draw with the slower DOM renderer." on={t.webgl} onChange={(on) => setTerm({ webgl: on })} />
        </Card>
      </Section>
    </>
  );
}

export function AgentsPage() {
  const mode = useStore((s) => resolveMode(s.settings.defaultMode));
  const planMode = useStore((s) => resolvePlanMode(s.settings.planApproveMode));
  const toolCalls = useStore((s) => s.settings.toolCalls);
  const modeId = useId();
  const planId = useId();
  const toolsId = useId();
  return (
    <>
      <PageHeading title="Agents">How new Claude sessions start and how their conversation reads. A project's own agents are in its project settings.</PageHeading>
      <section aria-labelledby={modeId} className="flex flex-col gap-2.5" data-setting="default-mode">
        <div className="flex flex-col gap-1 px-0.5">
          <h2 id={modeId} className="m-0 ui-text-11.5 font-semibold uppercase tracking-[0.08em] text-muted">
            Default permission mode
          </h2>
          <span className="ui-text-12 text-muted">For new Claude sessions. ⇧Tab in a session cycles modes.</span>
        </div>
        <RadioList value={mode} options={CLAUDE_MODES} onChange={(v) => updateSettings({ defaultMode: v })} labelledBy={modeId} />
      </section>
      <Section title="Plans and conversation">
        <Card>
          <Row setting="plan-approve" label="When a plan is approved, switch to" labelId={planId} hint="The mode Claude works in after you approve its plan.">
            <Segmented value={planMode} options={PLAN_APPROVE_MODES} onChange={(v) => updateSettings({ planApproveMode: v })} labelledBy={planId} />
          </Row>
          <Row setting="tool-calls" label="Tool calls in the conversation" labelId={toolsId} hint="Collapsed folds a run of calls into one row; expanded shows one row per call.">
            <Segmented<ToolCallView>
              value={toolCalls}
              options={[
                { id: "collapsed", label: "Collapsed" },
                { id: "expanded", label: "Expanded" },
              ]}
              onChange={(v) => updateSettings({ toolCalls: v })}
              labelledBy={toolsId}
            />
          </Row>
        </Card>
      </Section>
    </>
  );
}

const BANNER_LABELS = { blocked: "an agent needs you", done: "an agent is done", error: "an agent fails" } as const;

export function NotificationsPage() {
  const focused = useStore((s) => s.settings.notifyWhenFocused);
  const sounds = useStore((s) => s.settings.sounds);
  const banners = useStore((s) => s.settings.banners);
  const muted = useStore((s) => !!s.settings.muted);
  return (
    <>
      <PageHeading title="Notifications">How moonlet gets your attention when an agent finishes, fails or needs you.</PageHeading>
      <Section title="Desktop notifications">
        <Card>
          <SwitchRow
            setting="notify-focused"
            label="Notify even while moonlet is focused"
            hint="Off: a notification only when moonlet's window is in the background."
            on={focused}
            onChange={(on) => updateSettings({ notifyWhenFocused: on })}
          />
          {SOUND_EVENTS.map((ev) => (
            <SwitchRow
              key={ev.id}
              setting={`banner-${ev.id}`}
              label={`Notification when ${BANNER_LABELS[ev.id]}`}
              on={bannerOn(banners, ev.id)}
              onChange={(on) => updateSettings({ banners: { ...banners, [ev.id]: on } })}
            />
          ))}
        </Card>
      </Section>
      <Section title="Sounds" hint="Played when you are not watching the agent. macOS system sounds.">
        <Card>
          <SwitchRow setting="muted" label="Mute all sounds" hint="Also the bell in the sidebar footer." on={muted} onChange={(on) => updateSettings({ muted: on })} />
          {SOUND_EVENTS.map((ev) => {
            const current = soundFor(sounds, ev.id) ?? "";
            const id = `settings-sound-${ev.id}`;
            return (
              <div key={ev.id} data-setting={`sound-${ev.id}`} className="flex items-center gap-3 px-4 py-3">
                <StateGlyph state={ev.id} />
                <label htmlFor={id} className="flex-1 ui-text-13">
                  {ev.label}
                </label>
                <select id={id} className={cx(fieldCls, "w-[160px]")} value={current} onChange={(e) => updateSettings({ sounds: { ...DEFAULT_SOUNDS, ...sounds, [ev.id]: e.target.value } })}>
                  <option value="">Off</option>
                  {SYSTEM_SOUNDS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <IconButton title={current ? `Play ${current}` : "Play"} disabled={!current} onClick={() => void hostsApi.playSound(current).catch(errorToast)}>
                  <Play size={12} />
                </IconButton>
              </div>
            );
          })}
        </Card>
      </Section>
    </>
  );
}
