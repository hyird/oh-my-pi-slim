// Child output is untrusted terminal data. Keep readable line breaks without
// allowing escape sequences or terminal controls into the task card.
export function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*(?:[@-~]|$)/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "    ");
}

function failedAssistantMessage(message: any): boolean {
  return message?.stopReason === "error" || message?.stopReason === "aborted";
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
        live.set(
          index,
          update.type === "text_end"
            ? typeof update.content === "string"
              ? update.content
              : ""
            : (live.get(index) ?? "") + (typeof update.delta === "string" ? update.delta : ""),
        );
      }
    } else if (event?.type === "message_end" && event.message?.role === "assistant") {
      live.clear();
      if (failedAssistantMessage(event.message)) continue;
      for (const part of event.message.content ?? []) {
        if (part?.type === "text") replies.push(safeText(part.text));
      }
    }
  }
  return [...replies, ...Array.from(live.values(), safeText)].filter(Boolean);
}

/** Bounded live preview; full events remain in the private JSONL recording. */
export class ReplyAccumulator {
  private completed = "";
  private live = new Map<number, string>();
  private liveRawSize = 0;
  private cached = "";
  private dirty = false;
  constructor(private readonly limit = 24_000) {}

  record(event: any): void {
    if (event?.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type !== "text_delta" && update?.type !== "text_end") return;
      const index = typeof update.contentIndex === "number" ? update.contentIndex : -1;
      const previous = this.live.get(index) ?? "";
      // Keep a bounded raw prefix so escape sequences split across deltas can
      // be removed after they are complete, without retaining the whole stream.
      const room = Math.max(
        0,
        this.limit * 2 - this.completed.length - this.liveRawSize + previous.length,
      );
      // Bound malformed streams with unbounded content indices as well as text.
      if (!this.live.has(index) && this.live.size >= 256) return;
      const text =
        update.type === "text_end"
          ? typeof update.content === "string"
            ? update.content
            : ""
          : previous + (typeof update.delta === "string" ? update.delta : "");
      const next = text.slice(0, room);
      this.liveRawSize += next.length - previous.length;
      this.live.set(index, next);
    } else if (event?.type === "message_end" && event.message?.role === "assistant") {
      this.live.clear();
      this.liveRawSize = 0;
      if (!failedAssistantMessage(event.message)) {
        for (const part of event.message.content ?? []) {
          if (part?.type !== "text") continue;
          const text = safeText(part.text);
          if (text)
            this.completed = (this.completed + (this.completed ? "\n\n" : "") + text).slice(
              0,
              this.limit,
            );
        }
      }
    } else return;
    this.dirty = true;
  }

  text(): string {
    if (this.dirty) {
      this.cached = [this.completed, ...Array.from(this.live.values(), safeText)]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, this.limit);
      this.dirty = false;
    }
    return this.cached;
  }
}
