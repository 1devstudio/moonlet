// Settings › Machines › Sign-ins (X75): tools to sign in to on every member,
// whether each member is signed in, and Sign in on every member, whose
// browsers open on this Mac one after the other.

import { useEffect, useState } from "react";
import { KeyRound, Plus, RotateCw, X } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { M, type SignIn } from "../../lib/protocol";
import { addEntry, needSignIn, stateMark, type SignInState } from "../../lib/signIns";
import { errorToast, toast } from "../../lib/store";
import { Button, IconButton, cx } from "../ui";
import { Card, PageHeading, Section, fieldCls } from "./controls";

const LOCAL = "local";

function EntryRow({ entry, onRemove }: { entry: SignIn; onRemove: () => void }) {
  const [states, setStates] = useState<SignInState[] | null>(null);
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    rpc<SignInState[]>(LOCAL, M.signinsCheck, { entry: entry.id })
      .then(setStates, errorToast)
      .finally(() => setBusy(false));
  };
  useEffect(check, [entry.id, entry.login, entry.check]);
  const approve = () => void rpc(LOCAL, M.signinsApprove, { entry: entry.id }).then(check, errorToast);
  const missing = needSignIn(states ?? []);
  const run = () =>
    void rpc(LOCAL, M.signinsRun, { entry: entry.id, members: missing }).then(
      () => toast(`Signing in with ${entry.name} on ${missing.length === 1 ? "1 member" : `${missing.length} members`}; each browser opens here in turn`),
      errorToast,
    );
  const here = states?.[0];
  return (
    <div data-setting={`signin-${entry.id}`} className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <KeyRound size={14} className="text-muted" />
        <span className="flex-1 ui-text-13">{entry.name}</span>
        <IconButton title="Check again" disabled={busy} onClick={check}>
          <RotateCw size={13} className={cx(busy && "animate-spin")} />
        </IconButton>
        <IconButton title={`Remove ${entry.name}`} onClick={onRemove}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 ui-text-12">
        <span className="text-muted">Sign in</span>
        <span className="selectable font-mono">{entry.login}</span>
        <span className="text-muted">Check</span>
        <span className="selectable font-mono">{entry.check}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 ui-text-12">
        {(states ?? []).map((s) => {
          const m = stateMark(s.state);
          return (
            <span key={s.member} title={m.label} className={cx("flex items-center gap-1", s.state === "signed_in" ? "text-fg" : "text-muted")}>
              <span className={cx("font-mono", s.state === "signed_out" && "text-error")}>{m.mark}</span> {s.name}
            </span>
          );
        })}
        {states === null && <span className="text-faint">Checking…</span>}
      </div>
      <div className="flex gap-2">
        {here?.state === "needs_approval" && (
          <Button size="sm" onClick={approve}>
            Approve these commands on this Mac
          </Button>
        )}
        <Button size="sm" disabled={!missing.length} onClick={run}>
          Sign in on every member
        </Button>
      </div>
    </div>
  );
}

export function SignInsPage() {
  const [entries, setEntries] = useState<SignIn[] | null>(null);
  const [draft, setDraft] = useState({ name: "", login: "", check: "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc<SignIn[]>(LOCAL, M.signinsList).then(setEntries, errorToast);
  }, []);
  const save = (next: SignIn[]) => {
    const before = entries;
    setEntries(next);
    rpc(LOCAL, M.signinsSet, { entries: next }).catch((e: unknown) => {
      setEntries(before);
      errorToast(e);
    });
  };
  const add = () => {
    const r = addEntry(entries ?? [], draft, crypto.randomUUID());
    if ("error" in r) return setError(r.error);
    setError(null);
    setDraft({ name: "", login: "", check: "" });
    save(r.entries);
  };
  const field = (key: keyof typeof draft, placeholder: string, label: string) => (
    <input aria-label={label} className={cx(fieldCls, "font-mono ui-text-12.5")} spellCheck={false} value={draft[key]} placeholder={placeholder} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
  );
  return (
    <>
      <PageHeading title="Sign-ins">Tools each of your machines signs in to on its own. Each browser opens on this Mac.</PageHeading>
      <Section title="Tools">
        <Card>
          {(entries ?? []).map((e) => (
            <EntryRow key={e.id} entry={e} onRemove={() => save((entries ?? []).filter((x) => x.id !== e.id))} />
          ))}
          {entries?.length === 0 && <span className="px-4 py-3.5 ui-text-12 text-faint">None.</span>}
        </Card>
      </Section>
      <Section title="Add a tool" hint="Each machine shows its commands in full and asks before it runs them the first time.">
        <Card>
          <div className="flex flex-col gap-2 px-4 py-3.5">
            {field("name", "npm", "Name")}
            {field("login", "npm login", "Sign-in command")}
            {field("check", "npm whoami", "Check command")}
            {error && <span className="ui-text-12 text-error">{error}</span>}
            <Button size="sm" className="self-start" onClick={add}>
              <Plus size={12} /> Add
            </Button>
          </div>
        </Card>
      </Section>
    </>
  );
}
