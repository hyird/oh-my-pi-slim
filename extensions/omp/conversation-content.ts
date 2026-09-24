// Child output is untrusted terminal data. Keep readable line breaks without
// allowing escape sequences or terminal controls into the task card.
export function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "    ");
}

/** Return only assistant text. A completed message replaces its streamed deltas. */
export function assistantReplies(events: readonly any[]): string[] {
  const replies: string[] = [];
  const live = new Map<number, string>();
  for (const event of events) {
    if (event?.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" || update?.type === "text_end") {
        const index = typeof update.contentIndex === "number" ? update.contentIndex : -1;
        live.set(index, update.type === "text_end"
          ? safeText(update.content)
          : (live.get(index) ?? "") + safeText(update.delta));
      }
    } else if (event?.type === "message_end" && event.message?.role === "assistant") {
      live.clear();
      for (const part of event.message.content ?? []) {
        if (part?.type === "text") replies.push(safeText(part.text));
      }
    }
  }
  return [...replies, ...live.values()].filter(Boolean);
}
