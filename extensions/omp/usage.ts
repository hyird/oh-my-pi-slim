import * as fs from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";
import { RECOVERY_ENTRY } from "./recovery.ts";

export const USAGE_ENTRY = "omp-usage-v1";
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const COST_KEYS = [...TOKEN_KEYS, "total"] as const;
const amount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export const emptyUsage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Token splits are disjoint; reasoning tokens are already part of output. */
export function addUsage(target: Usage, source: Partial<Usage> | undefined): Usage {
  for (const key of TOKEN_KEYS) target[key] += amount(source?.[key]);
  for (const key of COST_KEYS) target.cost[key] += amount(source?.cost?.[key]);
  target.totalTokens = TOKEN_KEYS.reduce((total, key) => total + target[key], 0);
  return target;
}

export function usageDelta(total: Usage, baseline: Usage): Usage {
  const delta = emptyUsage();
  for (const key of TOKEN_KEYS) delta[key] = Math.max(0, total[key] - baseline[key]);
  for (const key of COST_KEYS) delta.cost[key] = Math.max(0, total.cost[key] - baseline.cost[key]);
  return addUsage(delta, undefined);
}

/** Match Pi's cumulative accounting, including tool, compaction and branch-summary calls. */
export function sessionUsage(entries: readonly any[]): Usage {
  const total = emptyUsage();
  for (const entry of entries) {
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")
      addUsage(total, entry.usage);
    else if (entry.type === "message" && ["assistant", "toolResult"].includes(entry.message?.role))
      addUsage(total, entry.message.usage);
  }
  return total;
}

/** Read only at run boundaries, never on a render frame. Unavailable files use event accounting. */
export function nativeSessionUsage(file: string | undefined): Usage | undefined {
  if (!file) return;
  try {
    const entries = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    if (entries[0]?.type !== "session") return;
    return sessionUsage(entries);
  } catch {
    return;
  }
}

/** Each run stores a replacement snapshot, so progress, delivery and reload cannot double count it. */
export class ChildUsageLedger {
  private runs = new Map<string, Usage>();
  private runTasks = new Map<string, string>();
  private sum = emptyUsage();

  get total(): Usage { return this.sum; }

  record(runId: string, usage: Partial<Usage>, taskId?: string): boolean {
    if (taskId) this.runTasks.set(runId, taskId);
    const next = addUsage(emptyUsage(), usage);
    const previous = this.runs.get(runId);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return false;
    this.runs.set(runId, next);
    if (previous) {
      for (const key of TOKEN_KEYS) this.sum[key] -= previous[key];
      for (const key of COST_KEYS) this.sum.cost[key] -= previous.cost[key];
    }
    addUsage(this.sum, next);
    return true;
  }

  restore(entries: readonly any[], tasks: readonly { taskId: string; sessionFile?: string }[] = []): void {
    this.runs.clear();
    this.runTasks.clear();
    this.sum = emptyUsage();
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType === RECOVERY_ENTRY && Array.isArray(entry.data?.jobs)) {
        // Older sessions already contain terminal run usage in recovery checkpoints.
        for (const job of entry.data.jobs) {
          if (typeof job?.id !== "string" || !Array.isArray(job.results)) continue;
          job.results.forEach((result: any, index: number) => {
            if (result?.usage && typeof result.usage === "object")
              this.record(typeof result.runId === "string" ? result.runId : `legacy:${job.id}:${index}`, result.usage,
                typeof result.taskId === "string" ? result.taskId : undefined);
          });
        }
      } else if (entry.customType === USAGE_ENTRY && typeof entry.data?.runId === "string" &&
        entry.data.usage && typeof entry.data.usage === "object") {
        this.record(entry.data.runId, entry.data.usage,
          typeof entry.data.taskId === "string" ? entry.data.taskId : undefined);
      }
    }
    const known = new Map<string, Usage>();
    for (const [runId, taskId] of this.runTasks) {
      const total = known.get(taskId) ?? emptyUsage();
      addUsage(total, this.runs.get(runId));
      known.set(taskId, total);
    }
    // Recover usage flushed during shutdown, and hidden calls from pre-ledger sessions.
    for (const task of tasks) {
      const native = nativeSessionUsage(task.sessionFile);
      if (native) this.record(`native:${task.taskId}`, usageDelta(native, known.get(task.taskId) ?? emptyUsage()));
    }
  }
}
