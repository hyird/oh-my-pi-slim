import {
  getMarkdownTheme,
  type AgentToolResult,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  MouseRegion,
  Text,
  TruncatedText,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { AgentProgress, Assignment, OmpDetails, Result, ToolOperation } from "./subagents.ts";
import { getConversation } from "./transcript.ts";
import { ReplyAccumulator, safeText } from "./conversation-content.ts";

const OUTPUT_LIMIT = 12_000;
const OUTPUT_LINES = 180;
// Match Pi's Working loader cadence and glyphs.
export const OMP_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Keep the fixed card's background across resets inserted by text truncation. */
export function paintPinnedBackground(
  theme: Theme,
  color: Parameters<Theme["bg"]>[0],
  text: string,
): string {
  if (typeof theme.getBgAnsi !== "function") return theme.bg(color, text);
  const base = theme.getBgAnsi(color);
  let active = base;
  const restored = text.replace(/\x1b\[([0-9;]*)m/g, (sequence, parameters: string) => {
    const codes = parameters ? parameters.split(";").map(Number) : [0];
    if (codes.some((code) => code === 48 || (code >= 40 && code <= 47) ||
      (code >= 100 && code <= 107))) {
      active = sequence;
      return sequence;
    }
    if (codes.includes(49)) {
      active = base;
      return sequence + base;
    }
    return codes.includes(0) ? sequence + active : sequence;
  });
  return theme.bg(color, restored);
}

export function formatTokenRate(rate: number): string {
  return `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} token/s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function taskUsageLabels(item?: AgentProgress, final?: Result): string[] {
  const labels: string[] = [];
  const elapsed = item?.elapsedMs ?? final?.timings?.totalMs ??
    (item?.state === "running" && item.startedAt !== undefined ? Date.now() - item.startedAt : undefined);
  if (elapsed !== undefined && Number.isFinite(elapsed)) labels.push(formatDuration(elapsed));
  const tokens = final?.usage?.totalTokens ?? item?.totalTokens;
  if (tokens !== undefined && Number.isFinite(tokens) && tokens >= 0)
    labels.push(`${formatTokens(tokens)} tokens`);
  const dcp = item ? item.dcpStatus : final?.dcpStatus;
  if (dcp) labels.push(dcp);
  return labels;
}

function boundedOutput(value: string): string {
  const lines = safeText(value).trim().split("\n");
  const shown = lines.slice(0, OUTPUT_LINES).join("\n");
  const chars = Array.from(shown);
  if (chars.length > OUTPUT_LIMIT)
    return `${chars.slice(0, OUTPUT_LIMIT).join("")}\n… (output truncated)`;
  return lines.length > OUTPUT_LINES ? `${shown}\n… (output truncated)` : shown;
}

function stateInfo(
  state: AgentProgress["state"],
  frame = 0,
): { icon: string; name: string; color: "muted" | "warning" | "success" | "error" } {
  switch (state) {
    case "running":
      return {
        icon: OMP_SPINNER_FRAMES[frame % OMP_SPINNER_FRAMES.length],
        name: "running",
        color: "warning",
      };
    case "done":
      return { icon: "✓", name: "done", color: "success" };
    case "failed":
      return { icon: "✗", name: "failed", color: "error" };
    case "cancelled":
      return { icon: "■", name: "cancelled", color: "warning" };
    default:
      return { icon: "○", name: "queued", color: "muted" };
  }
}

// Cards use role-based task names, never task text (which may contain
// commands or credentials). Full assignments stay in local recordings.
function taskName(agent: string, index: number, count: number): string {
  const title =
    agent === "council"
      ? "Council review"
      : `${agent.charAt(0).toUpperCase()}${agent.slice(1)} task`;
  return count > 1 ? `${title} ${index + 1}` : title;
}

function taskStatusLabels(item: AgentProgress | undefined, state: AgentProgress["state"]): string[] {
  if (!item || state !== "running") return [];
  const labels: string[] = [];
  const lastEventAt = item.lastEventAt;
  if (typeof lastEventAt === "number" && Number.isFinite(lastEventAt)) {
    const quietMinutes = Math.floor(Math.max(0, Date.now() - lastEventAt) / 60_000);
    if (quietMinutes > 0) labels.push(`quiet:${quietMinutes}m`);
  }
  // Only fixed OMP phases are rendered. Activity text can contain tool paths or
  // provider data, so it must never be used as a task-row label.
  switch (item.phase) {
    case "starting": labels.push("starting"); break;
    case "model": labels.push("working"); break;
    case "tool": labels.push("tool"); break;
    case "retrying": {
      const attempt = item.retry?.attempt;
      const max = item.retry?.max;
      labels.push(Number.isSafeInteger(attempt) && Number.isSafeInteger(max)
        ? `retrying:${attempt}/${max}` : "retrying");
      break;
    }
    case "retry-failed": labels.push("error"); break;
    case "settling": labels.push("finishing"); break;
  }
  return labels;
}

export interface OmpRenderState {
  card?: Container;
  expanded?: Set<number>;
  expandedOperation?: string;
  hovered?: number;
  inlineRange?: string;
  detail?: {
    task: string;
    taskIndex: number;
    reply: string | undefined;
    operations: readonly ToolOperation[] | undefined;
    theme: Theme;
    palette: string;
    view: Component;
  };
}
export type PinnedOmpBatch =
  | { kind: "call"; tasks: readonly Assignment[]; state: OmpRenderState }
  | {
      kind: "job";
      progress: readonly AgentProgress[];
      results?: readonly Result[];
      isPartial: boolean;
      frame: () => number;
      state: OmpRenderState;
    };
interface Interaction {
  state: OmpRenderState;
  invalidate: () => void;
  toggle?: (index: number) => void;
  hover?: (index: number) => void;
}

function taskRow(
  line: string | (() => string),
  index: number,
  theme: Theme,
  interaction?: Interaction,
  throughput?: number,
  statusLabels?: () => readonly string[],
  usageLabels?: () => readonly string[],
): Component {
  const currentLine = () => (typeof line === "function" ? line() : line);
  let previousLine = currentLine();
  let text = new TruncatedText(previousLine);
  const renderText = (width: number) => {
    const base = currentLine();
    if (base !== previousLine) {
      text = new TruncatedText(base);
      previousLine = base;
    }
    let content = base;
    const range = interaction?.state.expanded?.has(index)
      ? interaction.state.inlineRange
      : undefined;
    if (range && visibleWidth(content) + visibleWidth(range) <= width)
      content += theme.fg("muted", range);
    for (const label of usageLabels?.() ?? []) {
      const suffix = ` · ${label}`;
      if (visibleWidth(content) + visibleWidth(suffix) <= width)
        content += theme.fg("muted", suffix);
    }
    if (throughput !== undefined && Number.isFinite(throughput) && throughput > 0) {
      const rate = ` · ${formatTokenRate(throughput)}`;
      if (visibleWidth(content) + visibleWidth(rate) <= width) content += theme.fg("muted", rate);
    }
    for (const label of statusLabels?.() ?? []) {
      const suffix = ` · ${label}`;
      if (visibleWidth(content) + visibleWidth(suffix) <= width)
        content += theme.fg("muted", suffix);
    }
    return content === base ? text.render(width) : new TruncatedText(content).render(width);
  };
  if (!interaction)
    return {
      render: renderText,
      invalidate() {
        text.invalidate();
      },
    };
  const highlighted: Component = {
    render(width) {
      const rows = renderText(width);
      return interaction.state.hovered === index && theme.bg
        ? rows.map((row) => theme.bg("selectedBg", row))
        : rows;
    },
    invalidate() {
      text.invalidate();
    },
  };
  return new MouseRegion(highlighted, (event) => {
    if (event.type === "move" || event.type === "press") {
      if (interaction.hover) interaction.hover(index);
      else if (interaction.state.hovered !== index) {
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
      const expanded = (interaction.state.expanded ??= new Set<number>());
      if (expanded.has(index)) expanded.delete(index);
      else {
        expanded.clear();
        expanded.add(index);
      }
      interaction.state.expandedOperation = undefined;
      interaction.invalidate();
      return { handled: true };
    }
    return undefined;
  });
}

function clearHoverOutsideRows(component: Component, interaction: Interaction): Component {
  return clearHoverOutsideTasks(component, [interaction.state], interaction.invalidate);
}

function clearHoverOutsideTasks(
  component: Component,
  states: readonly OmpRenderState[],
  invalidate: () => void,
): Component {
  return new MouseRegion(component, (event) => {
    if (event.type === "move" && states.some((state) => state.hovered !== undefined)) {
      for (const state of states) state.hovered = undefined;
      invalidate();
      return { handled: true };
    }
    if (event.type === "press" || event.type === "click") return { handled: true };
    return undefined;
  });
}

/** One heading and one ordered row list for all calls still fixed above the editor. */
export function renderPinnedOmpOverview(
  batches: readonly PinnedOmpBatch[],
  theme: Theme,
  invalidate: () => void,
  toggle: (state: OmpRenderState, index: number) => void,
): Component {
  const view = new Container();
  const states = batches.map((batch) => batch.state);
  type PinnedRow = {
    agent: string;
    index: number;
    count: number;
    status: AgentProgress["state"];
    state: OmpRenderState;
    frame: () => number;
    throughput?: number;
    item?: AgentProgress;
    final?: Result;
  };
  const rows = batches.flatMap((batch): PinnedRow[] => {
    if (batch.kind === "call")
      return batch.tasks.map((task, index) => ({
        agent: task.agent,
        index,
        count: batch.tasks.length,
        status: "queued" as const,
        state: batch.state,
        frame: () => 0,
        throughput: undefined as number | undefined,
        item: undefined,
      }));
    const count = Math.max(batch.progress.length, batch.results?.length ?? 0);
    return Array.from({ length: count }, (_, index) => {
      const item = batch.progress[index];
      const final = batch.results?.[index];
      const status = !batch.isPartial && final
        ? final.ok ? "done" : final.cancelled ? "cancelled" : "failed"
        : (item?.state ?? "queued");
      return {
        agent: item?.agent ?? final?.agent ?? "agent",
        index,
        count,
        status,
        state: batch.state,
        frame: batch.frame,
        throughput: item?.tokensPerSecond,
        item,
        final,
      };
    });
  });
  const done = rows.filter((row) => row.status === "done").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const cancelled = rows.filter((row) => row.status === "cancelled").length;
  const queued = rows.filter((row) => row.status === "queued").length;
  const active = batches.some((batch) => batch.kind === "call" || batch.isPartial);
  const status = active
    ? queued === rows.length ? "queued" : "running"
    : failed ? "failed" : cancelled ? "cancelled" : "done";
  const color = failed ? "error" : cancelled ? "warning" : status === "queued"
    ? "muted" : status === "running" ? "warning" : "success";
  const runningBatch = batches.find((batch): batch is Extract<PinnedOmpBatch, { kind: "job" }> =>
    batch.kind === "job" && batch.isPartial);
  const frame = () => runningBatch?.frame() ?? 0;
  let heading = new TruncatedText("");
  let headingText = "";
  view.addChild({
    render(width) {
      const icon = status === "running" ? OMP_SPINNER_FRAMES[frame() % OMP_SPINNER_FRAMES.length]
        : status === "queued" ? "○" : status === "failed" ? "✗"
        : status === "cancelled" ? "■" : "✓";
      const next = theme.fg(color, `${icon} `) + theme.fg("toolTitle", theme.bold("OMP")) +
        theme.fg("muted", ` · ${status} · ${done + failed + cancelled}/${rows.length}`);
      if (next !== headingText) {
        heading = new TruncatedText(next);
        headingText = next;
      }
      return heading.render(width);
    },
    invalidate() { heading.invalidate(); },
  });
  for (const row of rows) {
    const interaction: Interaction = {
      state: row.state,
      invalidate,
      toggle: (index) => toggle(row.state, index),
      hover: (index) => {
        if (row.state.hovered === index && states.every((state) => state === row.state || state.hovered === undefined)) return;
        for (const state of states) state.hovered = state === row.state ? index : undefined;
        invalidate();
      },
    };
    view.addChild(taskRow(() => {
      const { icon, name, color } = stateInfo(row.status, row.frame());
      const expanded = row.state.expanded?.has(row.index) ?? false;
      return theme.fg(color, `${icon} ${name}`) + theme.fg("muted", " · ") +
        theme.fg("accent", taskName(row.agent, row.index, row.count)) +
        theme.fg("muted", expanded ? " ▾" : " ▸");
    }, row.index, theme, interaction, row.throughput,
    () => taskStatusLabels(row.item, row.status), () => taskUsageLabels(row.item, row.final)));
  }
  return clearHoverOutsideTasks(view, states, invalidate);
}

function taskDetails(
  task: string,
  reply: string | undefined,
  theme: Theme,
  operations: readonly ToolOperation[] = [],
  interaction?: Interaction,
  taskIndex = 0,
): Component {
  const view = new Container();
  view.addChild(new TruncatedText(theme.fg("muted", "  Task")));
  view.addChild(new Markdown(safeText(task), 2, 0, getMarkdownTheme()));
  if (operations.length) {
    view.addChild(new TruncatedText(theme.fg("muted", "  Tools")));
    operations.forEach((operation, operationIndex) => {
      const counts = operation.added !== undefined && operation.removed !== undefined
        ? theme.fg("toolDiffAdded", ` +${operation.added}`) +
          theme.fg("toolDiffRemoved", ` -${operation.removed}`)
        : "";
      const status = operation.state === "running" ? " …"
        : operation.state === "failed" ? " failed" : "";
      const key = `${taskIndex}:${operationIndex}:${operation.id}`;
      const expanded = () => interaction?.state.expandedOperation === key;
      const invocation = safeText(operation.invocation ?? operation.name);
      const color = operation.state === "failed" ? "error" : "muted";
      const detail = theme.fg(color, invocation) + counts + theme.fg(color, status);
      const compact = detail.replace(/\r?\n/g, " ↵ ");
      let canExpand = false;
      const line: Component = {
        render(width) {
          canExpand = visibleWidth(compact) > Math.max(1, width - 4);
          if (canExpand && expanded())
            return new Text(theme.fg("muted", "▾ ") + detail, 2, 0).render(width);
          const prefix = canExpand && interaction ? theme.fg("muted", "▸ ") : "";
          return new TruncatedText(prefix + compact, 2, 0)
            .render(width);
        },
        invalidate() {},
      };
      view.addChild(interaction ? new MouseRegion(line, (event) => {
        if (event.type !== "click" || event.button !== "left" || !canExpand) return undefined;
        interaction.state.expandedOperation = expanded() ? undefined : key;
        interaction.invalidate();
        return { handled: true };
      }) : line);
    });
  }
  if (reply) {
    view.addChild(new TruncatedText(theme.fg("muted", "  Assistant")));
    view.addChild(new Markdown(boundedOutput(reply), 2, 0, getMarkdownTheme()));
  }
  return view;
}

function assistantReply(
  item: AgentProgress | undefined,
  final: Result | undefined,
): string | undefined {
  if (item?.replyText !== undefined)
    return item.replyText || (final?.ok ? final.output : undefined);
  if (item?.conversationId) {
    try {
      const conversation = getConversation(item.conversationId);
      if (conversation) {
        const replies = new ReplyAccumulator();
        for (const event of conversation.events) replies.record(event);
        const text = replies.text();
        if (text) return text;
      }
    } catch {
      /* A missing recording should not break the tool card. */
    }
  }
  if (final?.ok && final.output) return final.output;
  return item?.text || undefined;
}

export function renderOmpCall(
  _label: string,
  tasks: readonly Assignment[],
  theme: Theme,
  interaction?: Interaction,
  showDetails = true,
): Component {
  const view = new Container();
  view.addChild(
    new TruncatedText(
      theme.fg("toolTitle", theme.bold("OMP")) + theme.fg("muted", ` · 0/${tasks.length}`),
    ),
  );
  tasks.forEach((task, index) => {
    const expanded = interaction?.state.expanded?.has(index) ?? false;
    view.addChild(
      taskRow(
        theme.fg("muted", "○ queued · ") +
          theme.fg("accent", taskName(task.agent, index, tasks.length)) +
          (interaction ? theme.fg("muted", expanded ? " ▾" : " ▸") : ""),
        index,
        theme,
        interaction,
      ),
    );
    if (expanded && showDetails)
      view.addChild(taskDetails(task.task, undefined, theme, [], interaction, index));
  });
  return view;
}

// Pi renders call and result components together. Keep the visible card in the
// call slot, then replace its contents when a progress or final result arrives.
export function renderOmpToolCall(
  label: string,
  tasks: readonly Assignment[],
  theme: Theme,
  state: OmpRenderState,
  invalidate: () => void = () => {},
): Component {
  const card = new Container();
  const interaction = { state, invalidate };
  card.addChild(
    clearHoverOutsideRows(renderOmpCall(label, tasks, theme, interaction), interaction),
  );
  state.card = card;
  return card;
}

export function renderOmpToolResult(
  result: AgentToolResult<OmpDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  state: OmpRenderState,
  invalidate: () => void = () => {},
  movedToWidget = false,
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

export function renderPinnedOmpDetail(
  task: string,
  item: AgentProgress | undefined,
  final: Result | undefined,
  theme: Theme,
  state?: OmpRenderState,
  invalidate: () => void = () => {},
  taskIndex = 0,
): Component {
  const reply = assistantReply(item, final);
  const operations = item?.operations;
  const palette = theme.fg("muted", "TaskTools") + theme.fg("text", "Assistant") +
    theme.fg("error", "failed");
  const cached = state?.detail;
  if (
    cached &&
    cached.task === task &&
    cached.taskIndex === taskIndex &&
    cached.reply === reply &&
    cached.operations === operations &&
    cached.theme === theme &&
    cached.palette === palette
  )
    return cached.view;
  const view = taskDetails(task, reply, theme, operations, state ? { state, invalidate } : undefined, taskIndex);
  if (state) state.detail = { task, taskIndex, reply, operations, theme, palette, view };
  return view;
}

export function renderOmpResult(
  result: AgentToolResult<OmpDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  interaction?: Interaction,
  showDetails = true,
  currentFrame?: () => number,
): Component {
  const view = new Container();
  const details = result.details;
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  const results = Array.isArray(details?.results) ? details.results : [];
  const frame = () => currentFrame?.() ?? details?.animationFrame ?? 0;
  // Results and progress are indexed by assignment, not role: council and
  // parallel delegate calls may contain several instances of the same role.
  const count = Math.max(progress.length, results.length);
  const complete = progress.filter((item) => item.state === "done").length;
  const failed = progress.filter((item) => item.state === "failed").length;
  const cancelled = progress.filter((item) => item.state === "cancelled").length;
  const queued = options.isPartial && progress.every((item) => item.state === "queued");
  const headerColor = cancelled
    ? "warning"
    : failed || (!options.isPartial && results.some((item) => !item.ok))
      ? "error"
      : queued
        ? "muted"
        : options.isPartial
          ? "warning"
          : "success";
  const finished = progress.length ? complete + failed + cancelled : results.length;
  const status = options.isPartial
    ? queued
      ? "queued"
      : "running"
    : cancelled
      ? "cancelled"
      : headerColor === "error"
        ? "failed"
        : "done";
  let heading = new TruncatedText("");
  let headingText = "";
  view.addChild({
    render(width) {
      const next =
        theme.fg(
          headerColor,
          options.isPartial
            ? queued
              ? "○ "
              : `${OMP_SPINNER_FRAMES[frame() % OMP_SPINNER_FRAMES.length]} `
            : cancelled
              ? "■ "
              : headerColor === "error"
                ? "✗ "
                : "✓ ",
        ) +
        theme.fg("toolTitle", theme.bold("OMP")) +
        theme.fg("muted", ` · ${status} · ${finished}/${count}`);
      if (next !== headingText) {
        heading = new TruncatedText(next);
        headingText = next;
      }
      return heading.render(width);
    },
    invalidate() {
      heading.invalidate();
    },
  });
  if (!count) return view;

  for (let index = 0; index < count; index++) {
    const item = progress[index];
    const final = results[index];
    const state =
      !options.isPartial && final
        ? final.ok
          ? "done"
          : final.cancelled
            ? "cancelled"
            : "failed"
        : (item?.state ?? "queued");
    const agent = item?.agent ?? final?.agent ?? "agent";
    const expanded = interaction?.state.expanded?.has(index) ?? false;
    view.addChild(
      taskRow(
        () => {
          const { icon, name, color } = stateInfo(state, frame());
          return (
            theme.fg(color, `${icon} ${name}`) +
            theme.fg("muted", " · ") +
            theme.fg("accent", taskName(agent, index, count)) +
            (interaction ? theme.fg("muted", expanded ? " ▾" : " ▸") : "")
          );
        },
        index,
        theme,
        interaction,
        item?.tokensPerSecond,
        () => taskStatusLabels(item, state),
        () => taskUsageLabels(item, final),
      ),
    );
    if (expanded && showDetails)
      view.addChild(taskDetails(item?.task ?? "", assistantReply(item, final), theme, item?.operations, interaction, index));
    // Only completed, successful final output. Progress text may be an interim
    // explanation; failed output may contain stderr or provider secrets.
    if (!interaction && !options.isPartial && state === "done" && final?.ok) {
      const output = boundedOutput(final.output);
      if (output) view.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
    }
  }
  return view;
}
