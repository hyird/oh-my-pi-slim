import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showConversationViewer as openViewer, transcriptBlocks } from "../extensions/omp/viewer.ts";
import * as transcript from "../extensions/omp/transcript.ts";
import { getConversation, listConversations, startConversation as recordConversation } from "../extensions/omp/transcript.ts";

const batchId = "viewer-test-batch";
const startConversation = (agent: Parameters<typeof recordConversation>[0], task: string, model: string) =>
  recordConversation(agent, task, model, batchId);
const showConversationViewer = (ctx: Parameters<typeof openViewer>[0]) => openViewer(ctx, batchId);

const original = process.env.PI_CODING_AGENT_DIR;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-viewer-")); process.env.PI_CODING_AGENT_DIR = dir; });
afterEach(() => { if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original; fs.rmSync(dir, { recursive: true, force: true }); });

function fakeUi(theme: any = { fg: (_role: string, value: string) => value, bg: (_role: string, value: string) => value, bold: (value: string) => value }, rows = 14) {
  let options: any;
  let component: any;
  let done: (() => void) | undefined;
  let doneCalls = 0;
  let paints = 0;
  const ctx: any = { mode: "tui", ui: { custom: (factory: any, opts: any) => new Promise<void>((resolve) => {
    options = opts;
    done = () => { doneCalls++; resolve(); };
    component = factory({ terminal: { rows }, requestRender: () => paints++ }, theme, {}, done);
  }) } };
  return { ctx, get component() { return component; }, get options() { return options; }, get paints() { return paints; }, get doneCalls() { return doneCalls; }, get done() { return done; } };
}
const text = (component: any, width = 60) => component.render(width).join("\n");
const send = (component: any, key: string) => component.handleInput(key);

test("persisted conversations, keyboard navigation, narrow width, and close", async () => {
  const old = startConversation("explorer", "first task", "model/a"); old.finish("done");
  await Bun.sleep(3);
  const recent = startConversation("designer", "second task", "model/b"); recent.finish("done");
  const ui = fakeUi(); const closed = showConversationViewer(ui.ctx);
  expect(text(ui.component)).toContain("OMP · conversations (2)");
  expect(text(ui.component)).toContain("Enter open · Esc/q close");
  send(ui.component, "\x1b[B");
  send(ui.component, "\r");
  expect(text(ui.component)).toContain("Task: first task");
  expect(text(ui.component)).toContain("Esc list · q close");
  for (const key of ["\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F", "\x1b[A", "\x1b[B"]) send(ui.component, key);
  expect(ui.component.render(22).every((line: string) => visibleWidth(line) <= 22)).toBe(true);
  send(ui.component, "\x1b");
  expect(text(ui.component)).toContain("conversations (2)");
  send(ui.component, "q"); await closed;
  const prior = ui.paints;
  const later = startConversation("fixer", "after close", "model/c"); later.finish("done");
  expect(ui.paints).toBe(prior); // subscription released
});

test("latest invocation lists every role, excludes other batches and ungrouped history, and opens complete records", async () => {
  recordConversation("explorer", "older batch", "model/a", "previous").finish("done");
  recordConversation("librarian", "ungrouped history", "model/a").finish("done");
  const explorer = recordConversation("explorer", "explore current", "model/a", batchId);
  explorer.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete answer" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "entire-file" } }] } });
  explorer.record({ type: "tool_execution_end", toolCallId: "call", toolName: "read", result: { content: "complete tool result" } });
  await Bun.sleep(3);
  recordConversation("designer", "design current", "model/b", batchId).finish("done");
  await Bun.sleep(3);
  recordConversation("fixer", "fix current", "model/c", batchId).finish("done");
  const ui = fakeUi(); const closed = openViewer(ui.ctx, batchId);
  const list = text(ui.component, 80);
  expect(list).toContain("conversations (3)");
  for (const task of ["explore current", "design current", "fix current"]) expect(list).toContain(task);
  expect(list).not.toContain("older batch");
  expect(list).not.toContain("ungrouped history");
  send(ui.component, "\x1b[F"); send(ui.component, "\r");
  text(ui.component, 80); // establish the detail viewport before moving to its start
  send(ui.component, "\x1b[H");
  expect(text(ui.component, 80)).toContain("Task: explore current");
  expect(text(ui.component, 80)).toContain("complete answer");
  const full = text(ui.component, 80);
  expect(full).not.toMatch(/Tool call|Tool result|complete tool result|entire-file|Model:/);
  send(ui.component, "q"); await closed;
});

test("missing invocation ID never falls back to disk history; empty help wraps on narrow screens", async () => {
  startConversation("explorer", "disk history", "model/a").finish("done");
  const ui = fakeUi(); const closed = openViewer(ui.ctx);
  expect(text(ui.component).replace(/[│]/g, " ").replace(/\s+/g, " ")).toContain("No delegated tasks in this Pi session yet. Delegate a task to view it here.");
  expect(text(ui.component)).not.toContain("disk history");
  const narrow = ui.component.render(22);
  expect(narrow.every((line: string) => visibleWidth(line) <= 22)).toBe(true);
  expect(narrow.join("\n")).toContain("Delegate a task");
  send(ui.component, "\r");
  expect(text(ui.component)).not.toContain("Task: disk history");
  startConversation("fixer", "new disk history", "model/a");
  await Bun.sleep(120);
  expect(text(ui.component)).toContain("conversations (0)");
  expect(text(ui.component)).not.toContain("new disk history");
  send(ui.component, "q"); await closed;
});

test("live refresh filters by invocation and keeps the selected task stable", async () => {
  recordConversation("explorer", "first current", "model/a", batchId);
  const selected = recordConversation("designer", "selected current", "model/b", batchId);
  const ui = fakeUi(); const closed = openViewer(ui.ctx, batchId);
  send(ui.component, "\x1b[B"); // select explorer, not the newest designer
  recordConversation("oracle", "different batch", "model/c", "other").finish("done");
  recordConversation("librarian", "legacy", "model/c").finish("done");
  recordConversation("fixer", "newest current", "model/c", batchId).finish("done");
  await Bun.sleep(120);
  const frame = text(ui.component, 80);
  expect(frame).toContain("conversations (3)");
  expect(frame).not.toContain("different batch");
  expect(frame).not.toContain("legacy");
  expect(frame.split("\n").find((line: string) => line.includes("first current"))).toContain("▸");
  send(ui.component, "\r");
  expect(text(ui.component)).toContain("Task: first current");
  send(ui.component, "\x1b");
  send(ui.component, "\x1b[H"); send(ui.component, "\r");
  expect(text(ui.component)).toContain("Task: newest current");
  selected.finish("done");
  send(ui.component, "q"); await closed;
});

test("semantic theme roles distinguish selection, status and assistant replies; repaint uses current theme", async () => {
  const running = startConversation("explorer", "working", "model/a");
  running.record({ type: "message_end", message: { role: "user", content: "user marker" } });
  running.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "assistant marker" }, { type: "toolCall", id: "one", name: "read", arguments: { path: "file" } }] } });
  running.record({ type: "tool_execution_end", toolCallId: "one", toolName: "read", result: { content: "result marker" } });
  await Bun.sleep(3);
  const completed = startConversation("designer", "finished", "model/b"); completed.finish("done");
  await Bun.sleep(3);
  const failed = startConversation("fixer", "broken", "model/c"); failed.finish("failed", "error marker");
  const calls: string[] = [];
  let palette = 1;
  const theme = {
    fg: (role: string, value: string) => { calls.push(`fg:${role}:${value}`); return `\x1b[38;5;${palette}m${value}\x1b[0m`; },
    bg: (role: string, value: string) => { calls.push(`bg:${role}`); return `\x1b[48;5;${palette}m${value}\x1b[0m`; },
    bold: (value: string) => value,
  };
  const ui = fakeUi(theme, 28); const closed = showConversationViewer(ui.ctx);
  const listFrame = ui.component.render(65);
  expect(listFrame.every((line: string) => visibleWidth(line) <= 65)).toBe(true);
  expect(calls.join("\n")).toContain("bg:selectedBg");
  expect(calls.join("\n")).toContain("fg:warning:  explorer · ◷ running");
  expect(calls.join("\n")).toContain("fg:success:  designer · ✓ done");
  expect(calls.join("\n")).toContain("fg:error:  fixer · ✗ failed");
  expect(calls.some((call) => call.startsWith("fg:border:╭"))).toBe(true);
  expect(calls.some((call) => call.startsWith("fg:accent:▸"))).toBe(true);
  expect(calls.some((call) => call.startsWith("fg:dim:"))).toBe(true);
  send(ui.component, "\x1b[F"); // last selected, not just the first highlighted row
  calls.length = 0; ui.component.render(65);
  expect(calls.filter((call) => call === "bg:selectedBg")).toHaveLength(2);
  send(ui.component, "\x1b[F"); send(ui.component, "\r");
  calls.length = 0; ui.component.render(65);
  expect(calls.join("\n")).toContain("fg:accent:OMP");
  send(ui.component, "\x1b[H"); calls.length = 0; ui.component.render(65);
  expect(calls.some((call) => call.includes("fg:accent:── Assistant"))).toBe(true);
  expect(calls.join("\n")).not.toMatch(/user marker|Tool call|Tool result|result marker/);
  calls.length = 0;
  const first = ui.component.render(65);
  expect(calls.some((call) => call.includes("fg:accent:── Assistant"))).toBe(true);
  palette = 2;
  const second = ui.component.render(65);
  expect(first.join("\n")).toContain("\x1b[38;5;1m");
  expect(second.join("\n")).toContain("\x1b[38;5;2m");
  expect(second.join("\n")).not.toContain("\x1b[38;5;1m");
  send(ui.component, "q"); await closed;
});

test("narrow navigation, readable help, wrapping and manual vs live follow", async () => {
  const convo = startConversation("designer", "task with a very long description ending FINAL TASK", "model/with-a-long-name");
  for (let i = 0; i < 25; i++) convo.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `message ${i}` }] } });
  const ui = fakeUi(); const closed = showConversationViewer(ui.ctx);
  for (const width of [12, 22, 38, 80]) {
    const rows = ui.component.render(width);
    expect(rows.every((line: string) => visibleWidth(line) <= width)).toBe(true);
    expect(rows[3]).toContain("▸");
  }
  expect(text(ui.component, 38)).toContain("Enter open");
  send(ui.component, "\r");
  expect(text(ui.component, 22)).toContain("live");
  send(ui.component, "\x1b[H");
  expect(text(ui.component, 22)).toContain("Task:");
  expect(text(ui.component, 22)).toContain("paused");
  convo.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "latest entry" }] } });
  await Bun.sleep(120);
  expect(text(ui.component, 22)).not.toContain("latest entry");
  send(ui.component, "\x1b[F");
  expect(text(ui.component, 22)).toContain("latest entry");
  send(ui.component, "\x1b[5~"); expect(text(ui.component, 22)).toContain("paused");
  send(ui.component, "\x1b[6~"); send(ui.component, "\x1b[F");
  expect(text(ui.component, 22)).toContain("live");
  send(ui.component, "\x1b"); expect(text(ui.component, 22)).toContain("OMP · tasks");
  send(ui.component, "\x1b"); await closed;
});

test("centered panel keeps its frame and footer visible at narrow widths and short heights", async () => {
  const ui = fakeUi(undefined, 9); const closed = showConversationViewer(ui.ctx);
  expect(ui.options).toEqual({ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } });
  for (const width of [12, 22, 38, 80]) {
    const lines = ui.component.render(width);
    expect(lines.length).toBeLessThanOrEqual(Math.floor(9 * 0.8));
    expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
    expect(lines[0]).toContain("╭");
    expect(lines.at(-1)).toContain("╯");
    expect(lines.at(-2)).toContain("0/0");
    expect(lines.join("\n")).toContain("No tasks");
  }
  send(ui.component, "q"); await closed;
});

test("selected titles stay readable and visible while paging a bounded list", async () => {
  for (let i = 0; i < 8; i++) {
    const task = startConversation("designer", `task ${i} readable title with more words`, "model/a");
    task.finish("done");
    await Bun.sleep(2);
  }
  const ui = fakeUi(undefined, 14); const closed = showConversationViewer(ui.ctx);
  for (const width of [12, 22, 38, 80]) {
    send(ui.component, "\x1b[F");
    const frame = text(ui.component, width);
    expect(frame).toContain("▸ task 0");
    expect(ui.component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
    send(ui.component, "\x1b[H");
    expect(text(ui.component, width)).toContain("▸ task 7");
  }
  send(ui.component, "\x1b[6~");
  expect(text(ui.component, 38)).toContain("▸ task");
  send(ui.component, "\r");
  expect(text(ui.component, 38)).toContain("Task: task");
  send(ui.component, "\x1b");
  expect(text(ui.component, 38)).toContain("▸ task");
  send(ui.component, "\x1b"); await closed;
});

test("external overlay disposal releases the subscription without completing the pending prompt", async () => {
  const ui = fakeUi();
  const pending = showConversationViewer(ui.ctx);
  ui.component.dispose();
  ui.component.dispose();
  send(ui.component, "q");
  expect(ui.doneCalls).toBe(0);
  const prior = ui.paints;
  const conversation = startConversation("explorer", "after disposal", "model/a");
  conversation.record({ type: "message_end", message: { role: "user", content: "hi" } });
  conversation.finish("done");
  await Bun.sleep(120); // also exercise any queued transcript notifications
  expect(ui.paints).toBe(prior);
  ui.done?.(); // simulate the host eventually settling the externally removed overlay
  await pending;
});

test("keyboard close and subsequent host disposal only complete the prompt once", async () => {
  const ui = fakeUi(); const closed = showConversationViewer(ui.ctx);
  send(ui.component, "q");
  ui.component.dispose();
  send(ui.component, "q");
  await closed;
  expect(ui.doneCalls).toBe(1);
});

test("viewer shows task and assistant replies while retaining full tool records on disk", async () => {
  const conversation = startConversation("explorer", "inspect\x1b[2J files", "model/a");
  conversation.record({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Please inspect" }] } });
  conversation.record({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "planning" } });
  conversation.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "temporary" } });
  conversation.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authoritative answer" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo complete arguments" } }] } });
  conversation.record({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo complete arguments" } });
  const huge = "X".repeat(24000) + "THE END";
  conversation.record({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: huge + "\x1b]0;injected\x07" }] } });
  expect(listConversations()).toHaveLength(1);
  const blocks = transcriptBlocks(getConversation(listConversations()[0].id)!.events);
  expect(blocks.find((block) => block.label.startsWith("Tool call"))?.text).toContain("echo complete arguments");
  expect(blocks.filter((block) => block.label.startsWith("Tool call"))).toHaveLength(1);
  expect(blocks.find((block) => block.label.startsWith("Tool result"))?.text.endsWith("THE END")).toBe(true);
  const ui = fakeUi(); const closed = showConversationViewer(ui.ctx);
  send(ui.component, "\r");
  let frame = text(ui.component, 70);
  expect(frame).toContain("following live");
  expect(frame).toContain("authoritative answer");
  expect(frame).not.toMatch(/THE END|Tool call|Tool result|echo complete arguments|Please inspect|Model:/);
  expect(frame).not.toContain("\x1b");
  send(ui.component, "\x1b[H");
  frame = text(ui.component);
  expect(frame).toContain("Task: inspect files");
  expect(frame).not.toContain("temporary");
  expect(frame).not.toContain("planning");
  expect(frame).not.toContain("\x1b");
  conversation.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "new live text" } });
  await Bun.sleep(120);
  expect(text(ui.component)).toContain("new live text");
  send(ui.component, "\x1b[H");
  expect(text(ui.component)).toContain("Task: inspect files");
  send(ui.component, "\x1b[F");
  expect(text(ui.component)).toContain("new live text");
  conversation.finish("done");
  send(ui.component, "q"); await closed;
});

test("unchanged full transcript is parsed once across paints and scrolling; width and append refresh it", async () => {
  const conversation = startConversation("explorer", "long transcript", "model/a");
  for (let i = 0; i < 120; i++) {
    conversation.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `entry ${i} ${"word ".repeat(12)}` }] } });
  }
  const id = listConversations()[0].id;
  const read = getConversation;
  let parses = 0;
  const snapshot = () => {
    const result = read(id)!;
    return { ...result, events: new Proxy(result.events, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) parses++;
        return Reflect.get(target, key, receiver);
      },
    }) };
  };
  let current = snapshot();
  const mock = spyOn(transcript, "getConversation").mockImplementation(() => current);
  const ui = fakeUi(); const closed = showConversationViewer(ui.ctx);
  try {
    send(ui.component, "\r");
    expect(text(ui.component, 50)).toContain("entry 119");
    expect(parses).toBe(1);
    for (let i = 0; i < 80; i++) {
      send(ui.component, "\x1b[5~");
      text(ui.component, 50);
    }
    send(ui.component, "\x1b[H");
    expect(text(ui.component, 50)).toContain("entry 0");
    expect(parses).toBe(1);
    expect(mock).toHaveBeenCalledTimes(1); // no full-log clone on every scroll
    text(ui.component, 40);
    expect(parses).toBe(2); // wrapping changes with width
    text(ui.component, 40);
    expect(parses).toBe(2);
    expect(mock).toHaveBeenCalledTimes(2);

    conversation.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "appended marker" }] } });
    current = snapshot(); // backend returns a new object when its file changes
    await Bun.sleep(120); // live notifications are throttled before cache invalidation
    send(ui.component, "\x1b[F");
    expect(text(ui.component, 40)).toContain("appended marker");
    expect(parses).toBe(3);
    text(ui.component, 40);
    expect(parses).toBe(3);
    conversation.finish("failed", "completion marker");
    current = snapshot();
    expect(text(ui.component, 40)).not.toContain("completion marker");
    expect(text(ui.component, 40)).toContain("failed");
    expect(parses).toBe(4);
  } finally {
    send(ui.component, "q"); await closed;
    mock.mockRestore();
  }
});

test("live notification invalidates wrapped lines even before the conversation identity changes", async () => {
  const conversation = startConversation("explorer", "live", "model/a");
  conversation.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "initial text" }] } });
  const id = listConversations()[0].id;
  const current = getConversation(id)!;
  const mock = spyOn(transcript, "getConversation").mockImplementation(() => current);
  const ui = fakeUi(); const closed = showConversationViewer(ui.ctx);
  try {
    send(ui.component, "\r");
    expect(text(ui.component)).toContain("initial text");
    // Simulate a backend that updates the current snapshot in place. The
    // subscription must invalidate the viewer even if identity stays stable.
    current.events.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "live append" }] } });
    expect(text(ui.component)).not.toContain("live append");
    conversation.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "live append" }] } });
    await Bun.sleep(120);
    expect(text(ui.component)).toContain("live append");
    current.meta.state = "failed";
    current.meta.error = "completion error";
    conversation.finish("failed", "completion error");
    expect(text(ui.component)).not.toContain("completion error");
    expect(text(ui.component)).toContain("failed");
  } finally {
    send(ui.component, "q"); await closed;
    mock.mockRestore();
  }
});

test("user string and array content, with informative non-text placeholders", () => {
  const blocks = transcriptBlocks([
    { type: "message_start", message: { role: "user", content: "original prompt" } },
    { type: "message_end", message: { role: "user", content: "original prompt" } },
    { type: "message_end", message: { role: "user", content: [
      { type: "text", text: "inspect this" }, { type: "image", mimeType: "image/png", data: "SECRETBASE64" },
    ] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", redacted: true }, { type: "text", text: "done" }] } },
  ]);
  expect(blocks.map((block) => block.text)).toEqual(["original prompt", "inspect this\n[image · image/png]", "[redacted thinking]", "done"]);
  expect(JSON.stringify(blocks)).not.toContain("SECRETBASE64");
});

test("partial tool output stays live through interruption, then authoritative end replaces it once", async () => {
  const conversation = startConversation("explorer", "partial output", "model/a");
  const ui = fakeUi(); const closed = showConversationViewer(ui.ctx);
  send(ui.component, "\r");
  const huge = "X".repeat(24000) + "PARTIAL END";
  conversation.record({ type: "tool_execution_update", toolCallId: "interrupted", toolName: "bash", partialResult: { content: [{ type: "text", text: huge + "\x1b[2J" }] } });
  let blocks = transcriptBlocks(getConversation(listConversations()[0].id)!.events);
  expect(blocks).toEqual([{ label: "Tool result · bash · live", text: huge }]);
  expect(text(ui.component, 70)).not.toContain("PARTIAL END");
  expect(text(ui.component, 70)).not.toContain("\x1b");
  conversation.record({ type: "tool_execution_update", toolCallId: "interrupted", toolName: "bash", partialResult: { content: [{ type: "text", text: "revised partial" }] } });
  blocks = transcriptBlocks(getConversation(listConversations()[0].id)!.events);
  expect(blocks).toEqual([{ label: "Tool result · bash · live", text: "revised partial" }]);
  conversation.record({ type: "tool_execution_end", toolCallId: "interrupted", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "interrupted\x1b]0;bad\x07" }] } });
  expect(transcriptBlocks(getConversation(listConversations()[0].id)!.events)).toEqual([{ label: "Tool result · bash · error", text: "interrupted" }]);
  conversation.record({ type: "message_end", message: { role: "toolResult", toolCallId: "interrupted", toolName: "bash", isError: true, content: [{ type: "text", text: "authoritative interruption" }] } });
  blocks = transcriptBlocks(getConversation(listConversations()[0].id)!.events);
  expect(blocks).toEqual([{ label: "Tool result · bash · error", text: "authoritative interruption" }]);
  expect(text(ui.component)).not.toContain("authoritative interruption");
  conversation.finish("failed");
  send(ui.component, "q"); await closed;
});

test("toolResult-only messages and paired execution events render exactly once", () => {
  const blocks = transcriptBlocks([
    { type: "message_end", message: { role: "toolResult", toolCallId: "one", toolName: "read", content: [{ type: "text", text: "only result" }, { type: "image", mimeType: "image/jpeg", data: "HIDDEN" }], isError: false } },
    { type: "tool_execution_end", toolCallId: "two", toolName: "bash", result: { content: [{ type: "text", text: "execution result" }] }, isError: false },
    { type: "message_end", message: { role: "toolResult", toolCallId: "two", toolName: "bash", content: [{ type: "text", text: "authoritative result" }], isError: true } },
  ]);
  expect(blocks.map((block) => block.text)).toEqual(["only result\n[image · image/jpeg]", "authoritative result"]);
  expect(blocks.map((block) => block.label)).toEqual(["Tool result · read", "Tool result · bash · error"]);
});

test("JSON mode event sequence preserves the complete conversation and de-duplicates calls", () => {
  const events = [
    { type: "session", version: 3 }, { type: "agent_start" }, { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: "What is in this file?", timestamp: 1 } },
    { type: "message_end", message: { role: "user", content: "What is in this file?", timestamp: 1 } },
    { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
    { type: "message_update", usage: { input: 10, output: 1 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Reading..." } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I'll read it" }, { type: "toolCall", id: "call_abc123", name: "read", arguments: { path: "example.txt" } }], stopReason: "toolUse" } },
    { type: "tool_execution_start", toolCallId: "call_abc123", toolName: "read", args: { path: "example.txt" } },
    { type: "tool_execution_end", toolCallId: "call_abc123", toolName: "read", result: { content: [{ type: "text", text: "file contents" }] }, isError: false },
    { type: "message_end", message: { role: "toolResult", toolCallId: "call_abc123", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false } },
    { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Draft" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final answer" }], stopReason: "stop" } },
    { type: "turn_end" }, { type: "agent_end" }, { type: "agent_settled" },
  ];
  expect(transcriptBlocks(events)).toEqual([
    { label: "User", text: "What is in this file?" },
    { label: "Assistant", text: "I'll read it" },
    { label: "Tool call · read", text: '{\n  "path": "example.txt"\n}' },
    { label: "Tool result · read", text: "file contents" },
    { label: "Assistant", text: "Final answer" },
  ]);
});

test("other completed conversation messages and interleaved streaming blocks stay visible", () => {
  expect(transcriptBlocks([
    { type: "message_end", message: { role: "system", content: "System instruction" } },
    { type: "message_end", message: { role: "custom", customType: "note", content: [{ type: "text", text: "Reminder" }] } },
    { type: "message_end", message: { role: "bashExecution", command: "pwd", output: "/project", exitCode: 0 } },
    { type: "message_end", message: { role: "compactionSummary", summary: "Previous context" } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "reply" } },
    { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "corrected reply" } },
  ]).map(({ label, text }) => [label, text])).toEqual([
    ["System", "System instruction"], ["Custom · note", "Reminder"],
    ["Bash execution", "pwd\n/project"], ["Compaction summary", "Previous context"],
    ["Assistant thinking · live", "plan"], ["Assistant · live", "corrected reply"],
  ]);
});

test("authoritative messages replace deltas; tool results retain full content", () => {
  expect(transcriptBlocks([
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "draft" } },
  ]).map((block) => block.text)).toEqual(["reasoning", "draft"]);
  const blocks = transcriptBlocks([
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "draft" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } },
    { type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "Z".repeat(22000) + "last" }] } },
  ]);
  expect(blocks.map((block) => block.text)).toEqual(["final", "Z".repeat(22000) + "last"]);
});
