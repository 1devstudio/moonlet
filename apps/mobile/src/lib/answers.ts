// Answering asks from the phone (X40): tool permissions, plans and terminal
// reads, behind Face ID when the user wants it.

import { rpc } from "@desktop/lib/daemon";
import { type PlanChoice, planAnswer } from "@desktop/lib/chat";
import { M } from "@desktop/lib/protocol";
import { dropSetup, useApp } from "./app";
import { needsFaceId } from "./cards";
import { confirmWithFaceId, tap } from "./native";

async function gate(answer: Parameters<typeof needsFaceId>[0], reason: string): Promise<boolean> {
  if (!needsFaceId(answer, useApp.getState().settings.faceId)) return true;
  return confirmWithFaceId(reason);
}

/** Asks for Face ID when `kind` needs it, sends the answer, and taps. */
async function answer(kind: Parameters<typeof needsFaceId>[0], reason: string, send: () => Promise<unknown>, feel: "success" | "warning"): Promise<boolean> {
  if (!(await gate(kind, reason))) return false;
  await send();
  void tap(feel);
  return true;
}

/** Allow, Always or Deny a tool; `message` tells the agent why on Deny. */
export const answerAsk = (host: string, terminal: number, ask: string, decision: "allow" | "always" | "deny", message?: string) =>
  answer(decision, "Allow the agent to use this tool", () => rpc(host, M.chatPermission, { id: terminal, ask, decision, ...(message ? { message } : {}) }), decision === "deny" ? "warning" : "success");

/** A plan choice (X20, X24). Feedback must not be empty. */
export async function answerPlan(host: string, terminal: number, ask: string, choice: PlanChoice, feedback = ""): Promise<boolean> {
  const params = planAnswer(choice, feedback, "auto");
  if (!params) return false;
  return answer(choice === "keepPlanning" ? "feedback" : "approve", "Start the agent on its plan", () => rpc(host, M.chatPermission, { id: terminal, ask, ...params }), "success");
}

/** Answers Claude's questions (`AskUserQuestion`); the answers steer it, so they wait for Face ID too. */
export const answerQuestion = (host: string, terminal: number, ask: string, answers: Record<string, string>) =>
  answer("question", "Answer the agent's question", () => rpc(host, M.chatPermission, { id: terminal, ask, decision: "allow", answers }), "success");

/** Answers an agent's request to read a terminal (X31). */
export const answerRead = (host: string, requestId: number, allow: boolean) =>
  answer(allow ? "read" : "deny", "Share the terminal's output with the agent", () => rpc(host, M.terminalReadAnswer, { request_id: requestId, allow, remember: false }), allow ? "success" : "warning");

/** Runs or skips a copy's setup on its Mac (X60, X62): Run names the exact
 * command shown, which the Mac refuses once it changed. */
export const answerSetup = (host: string, copy: string, command: string, runIt: boolean) =>
  answer(
    runIt ? "setup" : "deny",
    "Run this setup on the Mac",
    async () => {
      await rpc(host, runIt ? M.syncRunSetup : M.syncSkipSetup, runIt ? { copy, command } : { copy });
      dropSetup(host, copy);
    },
    runIt ? "success" : "warning",
  );
