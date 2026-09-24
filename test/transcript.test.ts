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
    expect(getConversation(run.id)?.events).toEqual([message("new")]);
    getConversation(run.id)!.events.push(message("not persisted"));
    expect(getConversation(run.id)?.events).toEqual([message("new")]);
    expect(reads).toBe(2);
    run.finish("done");
    expect(getConversation(run.id)?.meta.state).toBe("done");
    expect(reads).toBe(3);
  } finally { read.mockRestore(); run.finish("done"); }
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
