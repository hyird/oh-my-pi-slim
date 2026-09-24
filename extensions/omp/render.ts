import { getMarkdownTheme, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, TruncatedText, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentProgress, Assignment, OmpDetails, Result } from "./subagents.ts";
import { getConversation } from "./transcript.ts";
import { assistantReplies, safeText } from "./conversation-content.ts";

const OUTPUT_LIMIT = 12_000;
const OUTPUT_LINES = 180;
// Match Pi's Working loader cadence and glyphs.
export const OMP_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// Progress is presentation data, not a terminal escape stream. Never render raw tool
// result content: it can contain arbitrarily long output, arguments, or credentials.
function clean(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function boundedOutput(value: string): string {
  const lines = clean(value).trim().split("\n");
  const shown = lines.slice(0, OUTPUT_LINES).join("\n");
  const chars = Array.from(shown);
  if (chars.length > OUTPUT_LIMIT) return `${chars.slice(0, OUTPUT_LIMIT).join("")}\n… (output truncated)`;
  return lines.length > OUTPUT_LINES ? `${shown}\n… (output truncated)` : shown;
}

function stateInfo(state: AgentProgress["state"], frame = 0): { icon: string; name: string; color: "muted" | "warning" | "success" | "error" } {
  switch (state) {
    case "running": return { icon: OMP_SPINNER_FRAMES[frame % OMP_SPINNER_FRAMES.length], name: "running", color: "warning" };
    case "done": return { icon: "✓", name: "done", color: "success" };
    case "failed": return { icon: "✗", name: "failed", color: "error" };
    case "cancelled": return { icon: "■", name: "cancelled", color: "warning" };
    default: return { icon: "○", name: "queued", color: "muted" };
  }
}

// Cards use role-based task names, never task text (which may contain
// commands or credentials). Full assignments stay in local recordings.
function taskName(agent: string, index: number, count: number): string {
  const title = agent === "council" ? "Council review" : `${agent.charAt(0).toUpperCase()}${agent.slice(1)} task`;
  return count > 1 ? `${title} ${index + 1}` : title;
}

export interface OmpRenderState { card?: Container; expanded?: Set<number>; hovered?: number; inlineRange?: string }
interface Interaction { state: OmpRenderState; invalidate: () => void; toggle?: (index: number) => void }

function taskRow(line: string, index: number, theme: Theme, interaction?: Interaction): Component {
  const text = new TruncatedText(line);
  if (!interaction) return text;
  const highlighted: Component = {
    render(width) {
      const range = interaction.state.expanded?.has(index) ? interaction.state.inlineRange : undefined;
      const rows = range && visibleWidth(line) + visibleWidth(range) <= width
        ? new TruncatedText(line + theme.fg("muted", range)).render(width)
        : text.render(width);
      return interaction.state.hovered === index && theme.bg ? rows.map((row) => theme.bg("selectedBg", row)) : rows;
    },
    invalidate() { text.invalidate(); },
  };
  return new MouseRegion(highlighted, (event) => {
    if (event.type === "move" || event.type === "press") {
      if (interaction.state.hovered !== index) {
        interaction.state.hovered = index;
        interaction.invalidate();
      }
      return { handled: true, render: event.type === "press" };
    }
    if (event.type === "release") return { handled: true, render: false };
    if (event.type === "click" && event.button === "left") {
      if (interaction.toggle) {
        interaction.toggle(index);
        return { handled: true };
      }
      const expanded = interaction.state.expanded ??= new Set<number>();
      if (expanded.has(index)) expanded.delete(index);
      else { expanded.clear(); expanded.add(index); }
      interaction.invalidate();
      return { handled: true };
    }
    return undefined;
  });
}

function clearHoverOutsideRows(component: Component, interaction: Interaction): Component {
  return new MouseRegion(component, (event) => {
    if (event.type === "move" && interaction.state.hovered !== undefined) {
      interaction.state.hovered = undefined;
      interaction.invalidate();
      return { handled: true };
    }
    if (event.type === "press" || event.type === "click") return { handled: true };
    return undefined;
  });
}

function taskDetails(task: string, reply: string | undefined, theme: Theme): Component {
  const view = new Container();
  view.addChild(new TruncatedText(theme.fg("muted", "  Task")));
  view.addChild(new Markdown(safeText(task), 2, 0, getMarkdownTheme()));
  if (reply) {
    view.addChild(new TruncatedText(theme.fg("muted", "  Assistant")));
    view.addChild(new Markdown(boundedOutput(safeText(reply)), 2, 0, getMarkdownTheme()));
  }
  return view;
}

function assistantReply(item: AgentProgress | undefined, final: Result | undefined): string | undefined {
  if (item?.conversationId) {
    try {
      const conversation = getConversation(item.conversationId);
      const replies = conversation && assistantReplies(conversation.events);
      if (replies?.length) return replies.join("\n\n");
    } catch { /* A missing recording should not break the tool card. */ }
  }
  if (final?.ok && final.output) return final.output;
  return item?.text || undefined;
}

export function renderOmpCall(_label: string, tasks: readonly Assignment[], theme: Theme, interaction?: Interaction, showDetails = true): Component {
  const view = new Container();
  view.addChild(new TruncatedText(theme.fg("toolTitle", theme.bold("OMP")) + theme.fg("muted", ` · 0/${tasks.length}`)));
  tasks.forEach((task, index) => {
    const expanded = interaction?.state.expanded?.has(index) ?? false;
    view.addChild(taskRow(theme.fg("muted", "○ queued · ") + theme.fg("accent", taskName(task.agent, index, tasks.length)) + (interaction ? theme.fg("muted", expanded ? " ▾" : " ▸") : ""), index, theme, interaction));
    if (expanded && showDetails) view.addChild(taskDetails(task.task, undefined, theme));
  });
  return view;
}

// Pi renders call and result components together. Keep the visible card in the
// call slot, then replace its contents when a progress or final result arrives.
export function renderOmpToolCall(label: string, tasks: readonly Assignment[], theme: Theme, state: OmpRenderState, invalidate: () => void = () => {}): Component {
  const card = new Container();
  const interaction = { state, invalidate };
  card.addChild(clearHoverOutsideRows(renderOmpCall(label, tasks, theme, interaction), interaction));
  state.card = card;
  return card;
}

export function renderOmpToolResult(
  result: AgentToolResult<OmpDetails>, options: { expanded: boolean; isPartial: boolean }, theme: Theme, state: OmpRenderState, invalidate: () => void = () => {}, movedToWidget = false,
): Component {
  if (movedToWidget) {
    state.card?.clear();
    return new Container();
  }
  if (!state.card) return renderOmpResult(result, options, theme);
  const interaction = { state, invalidate };
  const updated = renderOmpResult(result, options, theme, interaction);
  state.card.clear();
  state.card.addChild(clearHoverOutsideRows(updated, interaction));
  return new Container();
}

export function renderPinnedOmpCall(
  tasks: readonly Assignment[], theme: Theme, state: OmpRenderState, invalidate: () => void, toggle?: (index: number) => void,
): Component {
  const interaction = { state, invalidate, toggle };
  return clearHoverOutsideRows(renderOmpCall("OMP", tasks, theme, interaction, false), interaction);
}

/** Status rows for the fixed editor area; the selected detail renders separately. */
export function renderPinnedOmpCard(
  progress: AgentProgress[], results: Result[] | undefined, animationFrame: number,
  theme: Theme, state: OmpRenderState, invalidate: () => void, isPartial = true, toggle?: (index: number) => void,
): Component {
  const interaction = { state, invalidate, toggle };
  const result: AgentToolResult<OmpDetails> = { content: [], details: { progress, results, animationFrame } };
  return clearHoverOutsideRows(renderOmpResult(result, { expanded: false, isPartial }, theme, interaction, false), interaction);
}

export function renderPinnedOmpDetail(task: string, item: AgentProgress | undefined, final: Result | undefined, theme: Theme): Component {
  return taskDetails(task, assistantReply(item, final), theme);
}

export function renderOmpResult(
  result: AgentToolResult<OmpDetails>, options: { expanded: boolean; isPartial: boolean }, theme: Theme, interaction?: Interaction, showDetails = true,
): Component {
  const view = new Container();
  const details = result.details;
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  const results = Array.isArray(details?.results) ? details.results : [];
  const frame = details?.animationFrame ?? 0;
  // Results and progress are indexed by assignment, not role: council and
  // parallel delegate calls may contain several instances of the same role.
  const count = Math.max(progress.length, results.length);
  const complete = progress.filter((item) => item.state === "done").length;
  const failed = progress.filter((item) => item.state === "failed").length;
  const cancelled = progress.filter((item) => item.state === "cancelled").length;
  const queued = options.isPartial && progress.every((item) => item.state === "queued");
  const headerColor = cancelled ? "warning" : failed || (!options.isPartial && results.some((item) => !item.ok)) ? "error" : queued ? "muted" : options.isPartial ? "warning" : "success";
  const finished = progress.length ? complete + failed + cancelled : results.length;
  const status = options.isPartial ? queued ? "queued" : "running" : cancelled ? "cancelled" : headerColor === "error" ? "failed" : "done";
  view.addChild(new TruncatedText(theme.fg(headerColor, options.isPartial ? queued ? "○ " : `${OMP_SPINNER_FRAMES[frame % OMP_SPINNER_FRAMES.length]} ` : cancelled ? "■ " : headerColor === "error" ? "✗ " : "✓ ") + theme.fg("toolTitle", theme.bold("OMP")) + theme.fg("muted", ` · ${status} · ${finished}/${count}`)));
  if (!count) return view;

  for (let index = 0; index < count; index++) {
    const item = progress[index];
    const final = results[index];
    const state = !options.isPartial && final ? final.ok ? "done" : final.cancelled ? "cancelled" : "failed" : item?.state ?? "queued";
    const { icon, name, color } = stateInfo(state, frame);
    const agent = item?.agent ?? final?.agent ?? "agent";
    const expanded = interaction?.state.expanded?.has(index) ?? false;
    view.addChild(taskRow(
      theme.fg(color, `${icon} ${name}`) + theme.fg("muted", " · ") + theme.fg("accent", taskName(agent, index, count)) + (interaction ? theme.fg("muted", expanded ? " ▾" : " ▸") : ""),
      index, theme, interaction,
    ));
    if (expanded && showDetails) view.addChild(taskDetails(item?.task ?? "", assistantReply(item, final), theme));
    // Only completed, successful final output. Progress text may be an interim
    // explanation; failed output may contain stderr or provider secrets.
    if (!interaction && !options.isPartial && state === "done" && final?.ok) {
      const output = boundedOutput(final.output);
      if (output) view.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
    }
  }
  return view;
}
