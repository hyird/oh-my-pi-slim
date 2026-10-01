import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readRecovery, RECOVERY_ENTRY, type RecoveryState } from "../extensions/omp/recovery.ts";

function checkpoint(): RecoveryState {
  const taskId = randomUUID();
  return { version: 1, parentId: "parent", scope: "scope",
    tasks: [{ taskId, agent: "fixer", scope: "scope", sessionFile: "child.jsonl" }],
    jobs: [{ id: "job", callId: "call", kind: "delegate", active: true,
      items: [{ agent: "fixer", task: "continue", taskId }], results: [null], delivered: [] }] };
}
const entry = (data: unknown) => ({ type: "custom", customType: RECOVERY_ENTRY, data });

test("recovery uses only the latest checkpoint on the selected parent branch", () => {
  const data = checkpoint();
  expect(readRecovery([entry(data)], "parent", "scope")).toEqual(data);
  expect(readRecovery([entry(data)], "other", "scope")).toBeUndefined();
  expect(readRecovery([entry(data)], "parent", "other")).toBeUndefined();
  expect(readRecovery([entry(data), entry({ version: 2 })], "parent", "scope")).toBeUndefined();
});

test("malformed recovery ownership and premature delivery markers cannot launch work", () => {
  for (const mutate of [
    (data: RecoveryState) => { data.tasks[0]!.taskId = "../escape"; },
    (data: RecoveryState) => { data.jobs[0]!.items[0]!.agent = "oracle"; },
    (data: RecoveryState) => { data.jobs[0]!.delivered = [0]; },
    (data: RecoveryState) => { data.jobs[0]!.kind = "council"; },
  ]) {
    const data = checkpoint(); mutate(data);
    expect(readRecovery([entry(data)], "parent", "scope")).toBeUndefined();
  }
});
