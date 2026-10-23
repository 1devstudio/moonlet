// A project's heavy commands (X62): which run on another machine without
// asking, once the user approved them. Pure: the project page renders it.

import type { HeavyConfig, HeavyInfo, HeavyOs } from "./protocol";

/** "a", "a and b", "a, b and c". */
export const joinNames = (names: string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Each command of the project's config, and whether it is approved. */
export function entryStates(info: HeavyInfo): { command: string; approved: boolean }[] {
  const approved = info.approved?.commands ?? [];
  return info.config.commands.map((command) => ({ command, approved: approved.includes(command) }));
}

/** Commands and variable names in the config that the approval does not cover. */
function unapproved(info: HeavyInfo): { commands: string[]; env: string[] } {
  const a = info.approved;
  return {
    commands: info.config.commands.filter((c) => !a?.commands.includes(c)),
    env: info.config.env.filter((e) => !a?.env.includes(e)),
  };
}

/** Whether routing waits for the user to approve the list again: removing an entry needs no approval. */
export function needsApproval(info: HeavyInfo): boolean {
  const { commands, env } = unapproved(info);
  return commands.length > 0 || env.length > 0;
}

/** The banner above **Approve**, or null when everything is approved. `machines` are those the approval covers. */
export function approvalBanner(info: HeavyInfo, machines: string[]): { title: string; text: string } | null {
  if (!needsApproval(info)) return null;
  const { commands, env } = unapproved(info);
  const title = !info.approved
    ? `${joinNames(info.config.commands)} ${info.config.commands.length === 1 ? "is" : "are"} not approved yet`
    : commands.length
      ? `${joinNames(commands)} ${commands.length === 1 ? "was" : "were"} added since you approved the list`
      : `${joinNames(env)} ${env.length === 1 ? "was" : "were"} added to Pass to the worker since you approved the list`;
  return {
    title,
    text: `Approving the list lets agents run it without asking, on ${joinNames(machines)}. Approved commands can run code from the project, including code the agent wrote, on this Mac.`,
  };
}

const SECRET = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$|^(TOKEN|KEY|SECRET|PASSWORD)$/i;

/** The warning under a variable name that looks like a secret, or null. */
export function secretWarning(name: string): string | null {
  return SECRET.test(name) ? `${name} looks like a secret. It reaches every machine that runs these commands, cloud machines too.` : null;
}

/** The toast after **Approve**. `unreachable` are machines the app could not approve on. */
export function approvedToast(project: string, commands: string[], machines: string[], unreachable: string[]): string {
  if (unreachable.length)
    return `Approved for ${project} on ${joinNames(machines)}. ${joinNames(unreachable)} ${unreachable.length === 1 ? "was" : "were"} not reachable; approve it from Workers.`;
  return `Approved ${joinNames(commands)} for ${project} on ${joinNames(machines)}`;
}

/** The Heavy commands section's form: lists of names as comma-separated text. */
export interface HeavyDraft {
  commands: string[];
  os: HeavyOs;
  env: string;
  outputs: string;
}

export const heavyDraft = (h: HeavyConfig | undefined): HeavyDraft => ({
  commands: h?.commands ?? [],
  os: h?.os ?? "any",
  env: (h?.env ?? []).join(", "),
  outputs: (h?.outputs ?? []).join(", "),
});

const names = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const heavyFromDraft = (d: HeavyDraft): HeavyConfig => ({
  commands: d.commands.map((c) => c.trim()).filter(Boolean),
  os: d.os,
  env: names(d.env),
  outputs: names(d.outputs),
});

/** Whether the form says something else than `orig` once read. */
export const heavyChanged = (orig: HeavyDraft, now: HeavyDraft): boolean => JSON.stringify(heavyFromDraft(orig)) !== JSON.stringify(heavyFromDraft(now));

/** The confirmation before approving a project's heavy commands on a
 * worker from the Workers page: the exact lists, as the project's page
 * shows them, so nothing is approved unseen. */
export function workerApproval(project: string, worker: string, info: HeavyInfo): { title: string; message: string; action: string; code: string } {
  const secrets = info.config.env.map(secretWarning).filter((w): w is string => !!w);
  const env = info.config.env.length ? `\n\nPass to the worker: ${info.config.env.join(", ")}` : "";
  return {
    title: `Approve ${project}'s heavy commands on ${worker}`,
    message: [`${worker} will run these for ${project} without asking. Approved commands can run code from the project, including code the agent wrote, on ${worker}.`, ...secrets].join(" "),
    action: "Approve",
    code: info.config.commands.join("\n") + env,
  };
}
