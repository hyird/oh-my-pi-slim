import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChildUsageLedger, USAGE_ENTRY, addUsage, emptyUsage, nativeSessionUsage, sessionUsage, sessionModelUsage, usageDelta } from "../extensions/omp/usage.ts";

const usage = () => addUsage(emptyUsage(), {
  input: 4, output: 5, cacheRead: 1, cacheWrite: 2,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
});

test("session totals include assistant, tool, compaction and summary usage across all entries", () => {
  const total = sessionUsage([
    { type: "message", message: { role: "assistant", usage: usage() } },
    { type: "message", message: { role: "toolResult", usage: usage() } },
    { type: "usage", usage: usage() },
    { type: "compaction", usage: usage() },
    { type: "branch_summary", usage: usage() },
    { type: "message", message: { role: "user", usage: usage() } },
    { type: "custom", data: { usage: usage() } },
  ]);
  expect(total.totalTokens).toBe(60);
  expect(total.input).toBe(20);
  expect(total.cacheWrite).toBe(10);
  expect(total.cost.total).toBeCloseTo(1.5);
});

test("run snapshots replace earlier progress while separate continuations and retries accumulate", () => {
  const ledger = new ChildUsageLedger();
  expect(ledger.record("run-1", usage())).toBe(true);
  expect(ledger.record("run-1", usage())).toBe(false);
  ledger.record("run-1", addUsage(usage(), usage()));
  ledger.record("run-2", usage());
  expect(ledger.total.totalTokens).toBe(36);
  ledger.record("run-1", usage());
  expect(ledger.total.totalTokens).toBe(24);
});

test("main usage follows historical model changes and merges input, output and cache tokens per model", () => {
  const totals = sessionModelUsage([
    { type: "model_change", provider: "test", modelId: "first" },
    { type: "message", message: { role: "assistant", provider: "test", model: "first", usage: usage() } },
    { type: "compaction", usage: usage() },
    { type: "model_change", provider: "test", modelId: "second" },
    { type: "message", message: { role: "assistant", provider: "test", model: "second", usage: usage() } },
    { type: "message", message: { role: "toolResult", usage: usage() } },
    { type: "usage", provider: "test", model: "first", usage: usage() },
  ], "test/current");
  expect(totals.get("test/first")?.totalTokens).toBe(36);
  expect(totals.get("test/second")?.totalTokens).toBe(24);
  expect(totals.has("test/current")).toBe(false);
});

test("child model attribution survives duplicate legacy snapshots and late attribution of old usage entries", () => {
  const ledger = new ChildUsageLedger();
  const entries = [
    { type: "custom", customType: USAGE_ENTRY, data: { runId: "run", usage: usage() } },
    { type: "custom", customType: "omp-recovery-v1", data: { jobs: [{ id: "job", results: [
      { runId: "run", model: "test/first", usage: usage() },
      { runId: "continuation", model: "test/second", usage: usage() },
    ] }] } },
    { type: "custom", customType: USAGE_ENTRY, data: { runId: "run", usage: usage() } },
  ];
  ledger.restore(entries);
  expect(ledger.byModel.get("test/first")?.totalTokens).toBe(12);
  expect(ledger.byModel.get("test/second")?.totalTokens).toBe(12);
  expect(ledger.byModel.get("other")?.totalTokens ?? 0).toBe(0);
  ledger.record("run", usage(), undefined, "test/second");
  expect(ledger.byModel.get("test/first")?.totalTokens).toBe(0);
  expect(ledger.byModel.get("test/second")?.totalTokens).toBe(24);
  expect(ledger.total.totalTokens).toBe(24);
});

test("reloading migrates repeated legacy checkpoints and retains delivered, failed and partial runs once", () => {
  const ledger = new ChildUsageLedger();
  const recovery = {
    type: "custom", customType: "omp-recovery-v1", data: { jobs: [{ id: "job", results: [
      { runId: "failed", ok: false, usage: usage() }, { usage: usage() },
    ] }] },
  };
  const entries = [recovery, recovery,
    { type: "custom", customType: USAGE_ENTRY, data: { runId: "partial", usage: usage() } },
    { type: "custom", customType: USAGE_ENTRY, data: { runId: "failed", usage: addUsage(usage(), usage()) } },
  ];
  ledger.restore(entries);
  expect(ledger.total.totalTokens).toBe(48);
  ledger.restore(entries);
  expect(ledger.total.totalTokens).toBe(48);
  ledger.restore([]);
  expect(ledger.total.totalTokens).toBe(0);
});

test("untrusted saved numbers cannot poison totals and reasoning is not counted twice", () => {
  const total = addUsage(emptyUsage(), {
    input: -1, output: 4, cacheRead: NaN, cacheWrite: Infinity, totalTokens: Infinity, reasoning: 3,
    cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, total: NaN },
  });
  expect(total.totalTokens).toBe(4);
  expect(total.cost.total).toBe(0);
  expect(usageDelta(usage(), addUsage(usage(), usage())).totalTokens).toBe(0);
});

test("child native run deltas include compaction without counting the task's earlier runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-usage-"));
  const file = path.join(dir, "session.jsonl");
  try {
    const entries: any[] = [{ type: "session" }, { type: "message", message: { role: "assistant", usage: usage() } }];
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const baseline = nativeSessionUsage(file)!;
    entries.push({ type: "compaction", usage: usage() }, { type: "message", message: { role: "assistant", usage: usage() } });
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    expect(usageDelta(nativeSessionUsage(file)!, baseline).totalTokens).toBe(24);
    const ledger = new ChildUsageLedger();
    const saved = [{ type: "custom", customType: USAGE_ENTRY,
      data: { runId: "earlier", taskId: "task", usage: usage() } }];
    // The native file can contain a compaction and a cancelled response not saved in the parent yet.
    ledger.restore(saved, [{ taskId: "task", sessionFile: file }]);
    expect(ledger.total.totalTokens).toBe(36);
    ledger.record("continuation", usage(), "task");
    expect(ledger.total.totalTokens).toBe(48);
    ledger.restore(saved, [{ taskId: "task", sessionFile: file }]);
    expect(ledger.total.totalTokens).toBe(36);
    fs.writeFileSync(file, '{"count": 1}');
    expect(nativeSessionUsage(file)).toBeUndefined();
    fs.writeFileSync(file, "invalid json");
    expect(nativeSessionUsage(file)).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
