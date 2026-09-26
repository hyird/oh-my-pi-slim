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

/** Bounded live preview; full events remain in the private JSONL recording. */
export class ReplyAccumulator {
  private completed = "";
  private live = new Map<number, string>();
  private liveSize = 0;
  private cached = "";
  private dirty = false;
  constructor(private readonly limit = 24_000) {}

  record(event: any): void {
    if (event?.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type !== "text_delta" && update?.type !== "text_end") return;
      const index = typeof update.contentIndex === "number" ? update.contentIndex : -1;
      const previous = this.live.get(index) ?? "";
      const room = Math.max(0, this.limit - this.completed.length - this.liveSize + previous.length);
      // Bound malformed streams with unbounded content indices as well as text.
      if (!this.live.has(index) && this.live.size >= 256) return;
      const text = update.type === "text_end" ? safeText(update.content)
        : (this.live.get(index) ?? "") + safeText(update.delta);
      const next = text.slice(0, room);
      this.liveSize += next.length - previous.length;
      this.live.set(index, next);
    } else if (event?.type === "message_end" && event.message?.role === "assistant") {
      this.live.clear();
      this.liveSize = 0;
      for (const part of event.message.content ?? []) {
        if (part?.type !== "text") continue;
        const text = safeText(part.text);
        if (text) this.completed = (this.completed + (this.completed ? "\n\n" : "") + text).slice(0, this.limit);
      }
    } else return;
    this.dirty = true;
  }

  text(): string {
    if (this.dirty) {
      this.cached = [this.completed, ...this.live.values()].filter(Boolean).join("\n\n").slice(0, this.limit);
      this.dirty = false;
    }
    return this.cached;
  }
}
