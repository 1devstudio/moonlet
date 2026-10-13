// Answering asks from the phone (X40): tool permissions, plans and terminal
// reads, behind Face ID when the user wants it.

import { rpc } from "@desktop/lib/daemon";
import { type PlanChoice, planAnswer } from "@desktop/lib/chat";
import { M } from "@desktop/lib/protocol";
import { useApp } from "./app";
import { needsFaceId } from "./cards";
import { confirmWithFaceId, tap } from "./native";

async function gate(answer: Parameters<typeof needsFaceId>[0], reason: string): Promise<boolean> {
  if (!needsFaceId(answer, useApp.getState().settings.faceId)) return true;
  return confirmWithFaceId(reason);
}

/** Allow, Always or Deny a tool; `message` tells the agent why on Deny. */
export async function answerAsk(host: string, terminal: number, ask: string, decision: "allow" | "always" | "deny", message?: string): Promise<boolean> {
  if (!(await gate(decision, "Allow the agent to use this tool"))) return false;
  await rpc(host, M.chatPermission, { id: terminal, ask, decision, ...(message ? { message } : {}) });
  void tap(decision === "deny" ? "warning" : "success");
  return true;
}

/** A plan choice (X20, X24). Feedback must not be empty. */
export async function answerPlan(host: string, terminal: number, ask: string, choice: PlanChoice, feedback = ""): Promise<boolean> {
  const params = planAnswer(choice, feedback, "auto");
  if (!params) return false;
  if (!(await gate(choice === "keepPlanning" ? "feedback" : "approve", "Start the agent on its plan"))) return false;
  await rpc(host, M.chatPermission, { id: terminal, ask, ...params });
  void tap("success");
  return true;
}

/** Answers an agent's request to read a terminal (X31). */
export async function answerRead(host: string, requestId: number, allow: boolean): Promise<boolean> {
  if (!(await gate(allow ? "allow" : "deny", "Share the terminal's output with the agent"))) return false;
  await rpc(host, M.terminalReadAnswer, { request_id: requestId, allow, remember: false });
  void tap(allow ? "success" : "warning");
  return true;
}
