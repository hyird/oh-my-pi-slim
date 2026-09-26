import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent } from "../extensions/omp/subagents.ts";
import { getConversation, startConversation } from "../extensions/omp/transcript.ts";

const previousDir = process.env.PI_CODING_AGENT_DIR;
const previousArgv = process.argv[1];
let root: string;
const ctx: any = { cwd: process.cwd(), isProjectTrusted: () => false };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-conversation-"));
  process.env.PI_CODING_AGENT_DIR = root;
});
afterEach(() => {
  process.argv[1] = previousArgv;
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const message = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
const fileFor = (id: string) => path.join(root, "omp", "conversations", `${id}.jsonl`);
function fake(events: any[], exit = 0) {
  const file = path.join(root, "fake.mjs");
  fs.writeFileSync(file, `for (const event of ${JSON.stringify(events)}) { console.log(JSON.stringify(event)); await new Promise(r => setTimeout(r, 30)); } process.exit(${exit});`);
  process.argv[1] = file;
}
async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("child JSON events and completion remain in one private recording", async () => {
  const long = "long output ".repeat(25_000);
  const events = [
    { type: "message_update", seq: 7, assistantMessageEvent: { type: "text_delta", delta: "first", contentIndex: 0 } },
    { type: "message_update", seq: 7, assistantMessageEvent: { type: "text_delta", delta: "second", contentIndex: 0 } },
    { type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: { content: [{ type: "text", text: long }] } },
    message(long),
  ];
  fake(events);
  let id = "";
  const pending = runAgent(ctx, { agent: "explorer", task: "sample" }, undefined, "test/model", (progress) => { id = progress.conversationId ?? id; });
  await waitUntil(() => !!id && !!getConversation(id)?.events.length);
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.output).toContain("[output truncated]");
  const conversation = getConversation(id)!;
  expect(conversation.meta.state).toBe("done");
  expect(conversation.meta.task).toBe("sample");
  expect(conversation.meta.finishedAt).toBeNumber();
  expect(conversation.events).toEqual(events);
  expect(fs.readFileSync(fileFor(id), "utf8")).toContain(long);
  expect(fs.readdirSync(path.dirname(fileFor(id)))).toEqual([`${id}.jsonl`]);
  if (process.platform !== "win32") {
    expect(fs.statSync(path.dirname(fileFor(id))).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileFor(id)).mode & 0o777).toBe(0o600);
  }
});

test("cache invalidates after append and completion without exposing caller mutations", () => {
  const run = startConversation("explorer", "live", "test/model");
  const originalRead = fs.readFileSync;
  let reads = 0;
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    if (typeof file === "number") reads++;
    return (originalRead as any)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    expect(getConversation(run.id)?.events).toEqual([]);
    expect(getConversation(run.id)?.events).toEqual([]);
    expect(reads).toBe(1);
    run.record(message("new"));
    run.flush();
    expect(getConversation(run.id)?.events).toEqual([message("new")]);
    getConversation(run.id)!.events.push(message("not persisted"));
    expect(getConversation(run.id)?.events).toEqual([message("new")]);
    expect(reads).toBe(2);
    run.finish("done");
    expect(getConversation(run.id)?.meta.state).toBe("done");
    expect(reads).toBe(3);
  } finally { read.mockRestore(); run.finish("done"); }
});

test("small events share writes and finish flushes every event in order", () => {
  const write = spyOn(fs, "writeSync");
  const events = Array.from({ length: 1000 }, (_, seq) => ({ type: "tick", seq }));
  const run = startConversation("explorer", "batch", "test/model");
  try {
    for (const event of events) run.record(event);
    expect(write).toHaveBeenCalledTimes(1); // metadata only before the deadline/size limit
    run.finish("done");
    expect(write).toHaveBeenCalledTimes(2);
    const lines = fs.readFileSync(fileFor(run.id), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    expect(lines.slice(1, -1).map(line => line.event)).toEqual(events);
    expect(lines.at(-1).state).toBe("done");
    run.finish("done");
    run.record({ type: "late" });
    expect(write).toHaveBeenCalledTimes(2);
  } finally { write.mockRestore(); run.finish("done"); }
});

test("live recordings flush on the deadline and UTF-8 byte limit", async () => {
  const run = startConversation("explorer", "limits", "test/model");
  try {
    run.record(message("live"));
    expect(getConversation(run.id)?.events).toEqual([]);
    await waitUntil(() => getConversation(run.id)?.events.length === 1);
    const large = message("测试".repeat(12_000));
    run.record(large);
    expect(getConversation(run.id)?.events).toEqual([message("live"), large]);
  } finally { run.finish("done"); }
});

test("timer write failures notify the owner and remain observable at finish", async () => {
  let failures = 0;
  const run = startConversation("explorer", "disk failure", "test/model", () => { failures++; });
  const write = spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("disk full"); });
  const close = spyOn(fs, "closeSync");
  try {
    run.record(message("pending"));
    await waitUntil(() => failures === 1);
    expect(() => run.record(message("later"))).toThrow("disk full");
    expect(() => run.finish("failed")).toThrow("disk full");
    expect(close).toHaveBeenCalledTimes(1);
    run.finish("failed");
    expect(close).toHaveBeenCalledTimes(1);
  } finally { write.mockRestore(); close.mockRestore(); run.finish("failed"); }
});

test("a background recording failure stops the child and reports failure", async () => {
  const script = path.join(root, "slow.mjs");
  fs.writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(message("partial")))}); await new Promise(r => setTimeout(r, 5000));`);
  process.argv[1] = script;
  const originalWrite = fs.writeSync;
  let writes = 0;
  const write = spyOn(fs, "writeSync").mockImplementation(((...args: any[]) => {
    if (++writes > 1) throw new Error("disk full");
    return (originalWrite as any)(...args);
  }) as any);
  const controller = new AbortController();
  let result: Awaited<ReturnType<typeof runAgent>> | undefined;
  const pending = runAgent(ctx, { agent: "explorer", task: "record" }, controller.signal, "test/model").then(value => { result = value; });
  try {
    await waitUntil(() => !!result);
    expect(result?.ok).toBe(false);
    expect(result?.output).toBe("Failed to save specialist conversation");
  } finally { controller.abort(); await pending; write.mockRestore(); }
});

test("cancellation flushes events still inside the buffer", async () => {
  const event = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } };
  fake([event, message("should not finish")]);
  const controller = new AbortController();
  let id = "";
  const result = await runAgent(ctx, { agent: "fixer", task: "cancel" }, controller.signal, "test/model", progress => {
    id = progress.conversationId ?? id;
    if (progress.text === "partial") controller.abort();
  });
  expect(result.cancelled).toBe(true);
  expect(getConversation(id)?.events).toEqual([event]);
  expect(getConversation(id)?.meta.state).toBe("cancelled");
});

test("each text/usage event emits one immutable snapshot with shared activity history", async () => {
  fake([
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_update", usage: { output: 10 }, assistantMessageEvent: { type: "text_delta", delta: "first" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " second", partial: { usage: { output: 20 } } } },
    { ...message("finished"), message: { ...message("finished").message, usage: { output: 30 } } },
  ]);
  const snapshots: any[] = [];
  const result = await runAgent(ctx, { agent: "explorer", task: "snapshots" }, undefined, "test/model", row => snapshots.push(row));
  expect(result.ok).toBe(true);
  expect(snapshots.map(row => row.text)).toEqual(["", "first", "first second", "finished", "finished"]);
  expect(snapshots[1].tokensPerSecond).toBeGreaterThan(0);
  expect(snapshots[2].tokensPerSecond).toBeGreaterThan(0);
  expect(snapshots[1].activities).toBe(snapshots[2].activities);
  expect(snapshots[2].activities).toEqual([]);
  expect(snapshots.at(-1).activities).toEqual(["Work completed"]);
  expect(snapshots.every(row => Object.isFrozen(row) && Object.isFrozen(row.activities))).toBe(true);
});

test("incomplete live lines become readable once finished", () => {
  const run = startConversation("explorer", "partial", "test/model");
  const tail = JSON.stringify({ type: "event", event: message("completed") }) + "\n";
  const cut = Math.floor(tail.length / 2);
  fs.appendFileSync(fileFor(run.id), tail.slice(0, cut));
  expect(getConversation(run.id)?.events).toEqual([]);
  fs.appendFileSync(fileFor(run.id), tail.slice(cut));
  expect(getConversation(run.id)?.events).toEqual([message("completed")]);
  run.finish("done");
});

test("invalid IDs and symlinked recordings are rejected even after caching", () => {
  const run = startConversation("explorer", "safe", "test/model");
  run.finish("done");
  expect(getConversation(run.id)?.meta.task).toBe("safe");
  expect(getConversation(`../${run.id}`)).toBeUndefined();
  const outside = path.join(root, "outside.jsonl");
  fs.copyFileSync(fileFor(run.id), outside);
  fs.unlinkSync(fileFor(run.id));
  try {
    fs.symlinkSync(outside, fileFor(run.id));
    expect(getConversation(run.id)).toBeUndefined();
  } catch (err: any) { if (err.code !== "EPERM") throw err; }
});

test("failed and cancelled children finalize their recordings", async () => {
  fake([message("partial")], 2);
  let failedId = "";
  const failed = await runAgent(ctx, { agent: "fixer", task: "failure" }, undefined, "test/model", (progress) => { failedId = progress.conversationId ?? failedId; });
  expect(failed.ok).toBe(false);
  expect(getConversation(failedId)?.meta.state).toBe("failed");
  expect(getConversation(failedId)?.events).toEqual([message("partial")]);

  fake(Array.from({ length: 30 }, (_, i) => ({ type: "message_update", seq: i, assistantMessageEvent: { type: "text_delta", delta: "x" } })));
  const controller = new AbortController();
  let cancelledId = "";
  const pending = runAgent(ctx, { agent: "fixer", task: "cancel" }, controller.signal, "test/model", (progress) => { cancelledId = progress.conversationId ?? cancelledId; });
  await waitUntil(() => !!cancelledId && !!getConversation(cancelledId)?.events.length);
  controller.abort();
  expect((await pending).cancelled).toBe(true);
  expect(getConversation(cancelledId)?.meta.state).toBe("cancelled");
  expect(getConversation(cancelledId)?.meta.finishedAt).toBeNumber();
});
