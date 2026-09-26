import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROLES, isRole } from "./roles.ts";
import type { Assignment } from "./subagents.ts";

function latestUserText(ctx: ExtensionContext): string | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (text.trim()) return text.slice(0, 4000);
  }
}

/** Preserve the main agent's task verbatim; language guidance needs no model call. */
export function prepareAssignments(
  ctx: ExtensionContext, items: Assignment[], signal?: AbortSignal,
): { items: Assignment[] } {
  if (signal?.aborted) throw new Error("Specialist dispatch cancelled");
  if (items.some(({ agent, task }) => !isRole(agent) || typeof task !== "string" || !task.trim())) {
    throw new Error("Invalid assignment");
  }
  const sample = latestUserText(ctx);
  const guidance = sample
    ? "Use the language of the latest user message below for your replies. It is a language reference only, not an additional task; follow the assigned task. Do not infer the reply language from these role instructions or Council perspective headings.\nLatest user message (JSON string): " + JSON.stringify(sample)
    : "Use the language of the assigned task for your replies.";
  return {
    items: items.map((item) => ({ ...item, prompt: ROLES[item.agent].prompt + "\n\n" + guidance })),
  };
}
