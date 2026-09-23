import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { getConversation, listConversations, subscribeConversations, type ConversationMeta } from "./transcript.ts";

// Child output is untrusted terminal data. Preserve readable line breaks, but never
// allow escape sequences, C1 controls, or cursor-moving control characters through.
export function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "    ");
}

function printable(value: unknown): string {
  if (typeof value === "string") return safeText(value);
  try { return safeText(JSON.stringify(value, null, 2)); } catch { return "[unreadable arguments]"; }
}

function contentText(parts: unknown): string {
  if (typeof parts === "string") return safeText(parts);
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => {
    if (part?.type === "text") return safeText(part.text);
    if (part?.type === "thinking") return safeText(part.thinking) || "[redacted thinking]";
    if (part?.type === "image") return `[image${part.mimeType ? ` · ${safeText(part.mimeType)}` : ""}]`;
    return `[${safeText(part?.type ?? "unknown")} block]`;
  }).join("\n");
}

interface Block { label: string; text: string }

/** Rebuild from persisted events: authoritative message_end replaces streamed deltas. */
export function transcriptBlocks(events: readonly any[]): Block[] {
  const blocks: Block[] = [];
  const provisional = new Map<number, Block>();
  const calls = new Set<string>();
  const results = new Map<string, Block>();
  const finishedResults = new Set<string>();
  const addCall = (part: any) => {
    const id = typeof part.id === "string" ? part.id : typeof part.toolCallId === "string" ? part.toolCallId : "";
    if (id && calls.has(id)) return;
    if (id) calls.add(id);
    blocks.push({ label: `Tool call · ${safeText(part.name ?? part.toolName ?? "tool")}`, text: printable(part.arguments ?? part.args ?? {}) });
  };
  for (const event of events) {
    if (event?.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (["text_delta", "thinking_delta", "text_end", "thinking_end"].includes(update?.type)) {
        const thinking = update.type.startsWith("thinking");
        const index = typeof update.contentIndex === "number" ? update.contentIndex : thinking ? -2 : -1;
        let block = provisional.get(index);
        if (!block || block.label !== (thinking ? "Assistant thinking · live" : "Assistant · live")) {
          block = { label: thinking ? "Assistant thinking · live" : "Assistant · live", text: "" };
          blocks.push(block);
          provisional.set(index, block);
        }
        if (update.type.endsWith("_end")) block.text = safeText(update.content);
        else block.text += safeText(update.delta);
      }
    } else if (event?.type === "message_end") {
      const message = event.message;
      if (!message || typeof message.role !== "string") continue;
      if (message.role === "assistant") {
        // The completed message is authoritative, including tool calls.
        for (const block of provisional.values()) { const index = blocks.indexOf(block); if (index >= 0) blocks.splice(index, 1); }
        provisional.clear();
      }
      if (message.role === "toolResult") {
        const id = message.toolCallId;
        const block = id && results.get(id);
        const label = `Tool result · ${safeText(message.toolName ?? "tool")}${message.isError ? " · error" : ""}`;
        const text = contentText(message.content);
        if (block) { block.label = label; block.text = text; }
        else {
          const result = { label, text };
          blocks.push(result);
          if (id) results.set(id, result);
        }
        if (id) finishedResults.add(id);
        continue;
      }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === "toolCall") addCall(part);
          else blocks.push({ label: `Assistant${part?.type === "thinking" ? " thinking" : ""}`, text: contentText([part]) });
        }
      } else if (message.role === "bashExecution") {
        blocks.push({ label: "Bash execution", text: `${safeText(message.command)}\n${safeText(message.output)}` });
      } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
        blocks.push({ label: message.role === "branchSummary" ? "Branch summary" : "Compaction summary", text: safeText(message.summary) });
      } else if ("content" in message) {
        const label = ({ user: "User", system: "System", custom: `Custom · ${safeText(message.customType ?? "message")}` } as Record<string, string>)[message.role] ?? safeText(message.role);
        blocks.push({ label, text: contentText(message.content) });
      }
    } else if (event?.type === "tool_execution_start") {
      addCall(event);
    } else if (event?.type === "tool_execution_update") {
      const id = event.toolCallId;
      if (id && finishedResults.has(id)) continue;
      if (event.partialResult === undefined) continue;
      const text = contentText(event.partialResult?.content ?? event.partialResult);
      const block = id && results.get(id);
      if (block) block.text = text;
      else {
        const result = { label: `Tool result · ${safeText(event.toolName ?? "tool")} · live`, text };
        blocks.push(result);
        if (id) results.set(id, result);
      }
    } else if (event?.type === "tool_execution_end") {
      const id = event.toolCallId;
      if (id && finishedResults.has(id)) continue;
      const block = id && results.get(id);
      const label = `Tool result · ${safeText(event.toolName ?? "tool")}${event.isError ? " · error" : ""}`;
      const text = contentText(event.result?.content ?? event.content);
      if (block) { block.label = label; block.text = text; }
      else {
        const result = { label, text };
        blocks.push(result);
        if (id) results.set(id, result);
      }
      if (id) finishedResults.add(id);
    }
  }
  return blocks;
}

type Tone = Parameters<Theme["fg"]>[0];
interface ViewerLine { text: string; tone: Tone; heading?: boolean }

function blockTone(label: string): Tone {
  if (label.startsWith("User")) return "userMessageText";
  if (label.startsWith("Assistant thinking")) return "thinkingText";
  if (label.startsWith("Assistant")) return "accent";
  if (label.startsWith("Tool call")) return "toolTitle";
  if (label.startsWith("Tool result")) return label.endsWith("error") ? "error" : "toolOutput";
  return "muted";
}

// Cache only plain text and semantic roles; theme colors are resolved at paint time.
function wrappedLines(text: string, width: number, tone: Tone, heading = false): ViewerLine[] {
  const indent = width >= 12 && !heading ? "  " : "";
  return text.split("\n").flatMap((line) =>
    wrapTextWithAnsi(line, Math.max(1, width - visibleWidth(indent))).map((part) => ({ text: indent + part, tone, heading })));
}

function linesFor(blocks: Block[], width: number): ViewerLine[] {
  const lines: ViewerLine[] = [];
  for (const block of blocks) {
    const tone = blockTone(block.label);
    lines.push(...wrappedLines(`── ${block.label} ──`, width, tone, true));
    lines.push(...wrappedLines(block.text || "(empty)", width, tone === "toolTitle" ? "toolOutput" : tone));
    lines.push({ text: "", tone: "muted" });
  }
  return lines;
}

/** Border, padding and content widths all use terminal columns, not string length. */
function panelLine(theme: Theme, text: string, width: number): string {
  if (width < 4) return theme.fg("border", truncateToWidth(text, width));
  const inner = width - 4;
  const content = truncateToWidth(text, inner);
  return theme.fg("border", "│ ") + content + " ".repeat(Math.max(0, inner - visibleWidth(content))) + theme.fg("border", " │");
}

function panelRule(theme: Theme, width: number, left: string, right: string): string {
  if (width < 2) return theme.fg("border", "─".repeat(width));
  return theme.fg("border", left + "─".repeat(width - 2) + right);
}

function taskLines(meta: ConversationMeta, width: number, selected: boolean): ViewerLine[] {
  const task = safeText(meta.task).replace(/\s+/g, " ") || "(untitled task)";
  const available = Math.max(1, width - 2);
  // Task first: don't spend the scarce columns on an agent name or a timestamp.
  const wrapped = wrapTextWithAnsi(task, available).slice(0, 2);
  const lines: ViewerLine[] = wrapped.map((part, index) => ({
    text: `${index === 0 && selected ? "▸ " : "  "}${part}`,
    tone: "text",
    heading: selected,
  }));
  if (width >= 18) {
    const state = meta.state === "running" ? "◷ running" : meta.state === "failed" ? "✗ failed" : "✓ done";
    lines.push({ text: width < 32 ? `  ${state}` : `  ${safeText(meta.agent)} · ${state}`, tone: meta.state === "running" ? "warning" : meta.state === "failed" ? "error" : "success" });
  }
  return lines;
}

/** One viewer per invocation; dispose the subscription even on abrupt UI cancellation. */
export async function showConversationViewer(ctx: ExtensionContext, delegationId?: string): Promise<void> {
  if (ctx.mode !== "tui") return;
  const conversationsForInvocation = () => delegationId
    ? listConversations().filter((meta) => meta.delegationId === delegationId)
    : [];
  await ctx.ui.custom((tui: TUI, theme, _keys, done): Component => {
    let list: ConversationMeta[] = conversationsForInvocation();
    let selected = 0;
    let id: string | undefined;
    let scroll = 0;
    let follow = false;
    let viewport = 1;
    let total = 0;
    let listStarts: number[] = [];
    let closed = false;
    // Keep only the open conversation's wrapped lines. The backend reuses the
    // conversation object while its file is unchanged; notifications also clear
    // this cache so live writes and completion cannot leave stale lines behind.
    let wrapped: { conversation: NonNullable<ReturnType<typeof getConversation>>; width: number; lines: ViewerLine[] } | undefined;
    const unsubscribe = subscribeConversations(() => {
      if (closed) return;
      wrapped = undefined;
      const selectedId = list[selected]?.id;
      list = conversationsForInvocation();
      const retained = selectedId ? list.findIndex((item) => item.id === selectedId) : -1;
      selected = retained >= 0 ? retained : Math.min(selected, Math.max(0, list.length - 1));
      if (!id) scroll = 0; // Recalculate item positions after a live list change.
      tui.requestRender();
    });
    const dispose = () => { if (closed) return; closed = true; wrapped = undefined; unsubscribe(); };
    const close = () => { if (closed) return; dispose(); done(undefined); };
    const status = (state: ConversationMeta["state"]) => `${state === "running" ? "◷" : state === "failed" ? "✗" : "✓"} ${state}`;
    const component: Component & { dispose(): void } = {
      render(width: number) {
        const w = Math.max(1, width);
        const inner = Math.max(1, w - 4);
        const height = Math.max(1, Math.floor((tui.terminal?.rows ?? 24) * 0.8));
        viewport = Math.max(0, height - 6); // title, two rules, footer and two outer borders
        let body: ViewerLine[] = [];
        let title: string;
        if (id) {
          // Only the open conversation is parsed and wrapped; paints and scrolling
          // reuse plain semantic lines, so theme changes never retain old colors.
          const conversation = wrapped?.width === inner ? wrapped.conversation : getConversation(id);
          const meta = conversation?.meta;
          title = meta ? `OMP · ${safeText(meta.agent)} · ${status(meta.state)}` : "OMP · conversation unavailable";
          if (conversation) {
            if (!wrapped || wrapped.conversation !== conversation || wrapped.width !== inner) {
              const lines: ViewerLine[] = [
                ...wrappedLines(`Task: ${safeText(meta!.task)}`, inner, "text"),
                { text: "", tone: "muted" },
                ...linesFor(transcriptBlocks(conversation.events).filter((block) => block.label === "Assistant" || block.label === "Assistant · live"), inner),
              ];
              wrapped = { conversation, width: inner, lines };
            }
            body = wrapped.lines;
          } else {
            wrapped = undefined;
            body = wrappedLines("Conversation unavailable", inner, "warning");
          }
        } else {
          title = inner < 24 ? `OMP · tasks (${list.length})` : `OMP · conversations (${list.length})`;
          listStarts = [];
          if (list.length) {
            for (const meta of list) {
              listStarts.push(body.length);
              body.push(...taskLines(meta, inner, listStarts.length - 1 === selected));
            }
          } else {
            body = wrappedLines(delegationId
              ? "No tasks found for the latest delegation. Delegate a task to start one."
              : "No delegated tasks in this Pi session yet. Delegate a task to view it here.", inner, "muted");
          }
        }
        total = body.length;
        if (id && follow) scroll = Math.max(0, total - viewport);
        if (!id && list.length && viewport) {
          const start = listStarts[selected]!;
          const end = selected + 1 < listStarts.length ? listStarts[selected + 1]! : total;
          if (start < scroll) scroll = start;
          if (start >= scroll + viewport) scroll = start;
          // On short terminals show at least the selected title, not an orphaned metadata line.
          else if (end > scroll + viewport && end - start <= viewport) scroll = end - viewport;
        }
        scroll = Math.max(0, Math.min(scroll, id ? Math.max(0, total - viewport) : Math.max(0, total - 1)));
        const shown = body.slice(scroll, scroll + viewport).map((line, offset) => {
          const index = scroll + offset;
          const next = !id ? listStarts.findIndex((start) => start > index) : -1;
          const item = !id && list.length ? next < 0 ? listStarts.length - 1 : next - 1 : -1;
          const active = item === selected && item >= 0;
          const painted = active && line.heading && line.text.startsWith("▸")
            ? theme.fg("accent", "▸") + theme.fg("text", theme.bold(line.text.slice(1)))
            : theme.fg(line.tone, line.heading ? theme.bold(line.text) : line.text);
          const padded = truncateToWidth(painted, inner);
          return panelLine(theme, active ? theme.bg("selectedBg", padded + " ".repeat(Math.max(0, inner - visibleWidth(padded)))) : padded, w);
        });
        const position = `${total ? scroll + 1 : 0}–${Math.min(total, scroll + viewport)}/${total}`;
        const marker = id ? follow ? inner >= 48 ? "following live" : "live" : "paused" : `${list.length ? selected + 1 : 0}/${list.length}`;
        const help = id ? "↑↓ PgUp/PgDn Home/End scroll · Esc list · q close" : "↑↓ PgUp/PgDn Home/End select · Enter open · Esc/q close";
        const compact = id ? "↑↓ Esc q" : "↑↓ ↵ Esc/q";
        const footer = inner >= 70 ? `${marker} · ${position}  ${help}`
          : inner >= 48 ? `${marker} · ${position}  ${id ? "↑↓ scroll · Esc list · q close" : "↑↓ select · Enter open · Esc/q close"}`
          : inner >= 32 ? `${marker} · ${position}  ${id ? "Esc list · q close" : "Enter open · Esc/q"}`
          : inner >= 18 ? `${marker} ${compact}` : `${marker} ${id ? "Esc" : "↵"}`;
        const top = panelRule(theme, w, "╭", "╮");
        const bottom = panelRule(theme, w, "╰", "╯");
        if (height < 6) return [top, ...shown.slice(0, Math.max(0, height - 3)), panelLine(theme, theme.fg("dim", truncateToWidth(marker, inner)), w), bottom].slice(0, height);
        return [
          top,
          panelLine(theme, theme.fg("accent", theme.bold(truncateToWidth(title, inner))), w),
          panelRule(theme, w, "├", "┤"),
          ...shown,
          ...Array.from({ length: viewport - shown.length }, () => panelLine(theme, "", w)),
          panelRule(theme, w, "├", "┤"),
          panelLine(theme, theme.fg("dim", truncateToWidth(footer, inner)), w),
          bottom,
        ];
      },
      invalidate() {},
      dispose,
      handleInput(data: string) {
        if (closed) return;
        if (matchesKey(data, "q")) return close();
        if (matchesKey(data, Key.escape)) {
          if (!id) return close();
          id = undefined; wrapped = undefined; scroll = 0; follow = false;
        } else if (!id && matchesKey(data, Key.enter)) {
          id = list[selected]?.id;
          wrapped = undefined; scroll = 0; follow = true;
        } else {
          const page = Math.max(1, viewport - 1);
          let move = 0;
          if (matchesKey(data, Key.up)) move = -1;
          if (matchesKey(data, Key.down)) move = 1;
          if (matchesKey(data, Key.pageUp)) move = -page;
          if (matchesKey(data, Key.pageDown)) move = page;
          if (matchesKey(data, Key.home)) move = -Infinity;
          if (matchesKey(data, Key.end)) move = Infinity;
          if (id) {
            if (move) {
              scroll = move === -Infinity ? 0 : move === Infinity ? Math.max(0, total - viewport) : Math.max(0, Math.min(total - viewport, scroll + move));
              follow = scroll >= total - viewport;
            }
          } else if (list.length && move) {
            selected = move === -Infinity ? 0 : move === Infinity ? list.length - 1 : Math.max(0, Math.min(list.length - 1, selected + move));
            follow = false;
          }
        }
        tui.requestRender();
      },
    };
    return component;
  }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } });
}
