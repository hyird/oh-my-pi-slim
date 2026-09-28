import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROLES, isRole } from "./roles.ts";
import type { Assignment } from "./subagents.ts";

function latestUserText(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") {
      if (/\S/.test(content)) return content.slice(0, 4000);
      continue;
    }
    let prefix = "";
    let hasText = false;
    let textParts = 0;
    for (const part of content) {
      if (part.type !== "text") continue;
      if (/\S/.test(part.text)) hasText = true;
      if (prefix.length < 4000) {
        if (textParts) prefix += "\n";
        prefix += part.text.slice(0, 4000 - prefix.length);
      }
      textParts++;
      if (prefix.length >= 4000 && hasText) break;
    }
    if (hasText) return prefix;
  }
}

/** Preserve the main agent's task verbatim; language guidance needs no model call. */
export function prepareAssignments(
  ctx: ExtensionContext,
  items: Assignment[],
  signal?: AbortSignal,
): { items: Assignment[] } {
  if (signal?.aborted) throw new Error("Specialist dispatch cancelled");
  if (items.some(({ agent, task }) => !isRole(agent) || typeof task !== "string" || !task.trim())) {
    throw new Error("Invalid assignment");
  }
  const sample = latestUserText(ctx);
  const guidance = sample
    ? "Use the language of the latest user message below for your replies. It is a language reference only, not an additional task; follow the assigned task. Do not infer the reply language from these role instructions or Council perspective headings.\nLatest user message (JSON string): " +
      JSON.stringify(sample)
    : "Use the language of the assigned task for your replies.";
  return {
    items: items.map((item) => ({
      ...item,
      prompt: ROLES[item.agent].prompt,
      instructions: guidance,
    })),
  };
}
