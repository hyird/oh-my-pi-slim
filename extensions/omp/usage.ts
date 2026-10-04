import * as fs from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";
import { RECOVERY_ENTRY } from "./recovery.ts";

export const USAGE_ENTRY = "omp-usage-v1";
export const UNKNOWN_MODEL = "other";
export type ModelUsage = ReadonlyMap<string, Usage>;
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

export function addModelUsage(target: Map<string, Usage>, model: string, usage: Partial<Usage> | undefined): void {
  const total = target.get(model) ?? emptyUsage();
  addUsage(total, usage);
  target.set(model, total);
}

export function mergeModelUsage(target: Map<string, Usage>, source: ModelUsage): void {
  for (const [model, usage] of source) addModelUsage(target, model, usage);
}

/** Preserve the model used for historical calls, independently of today's configuration. */
export function sessionModelUsage(entries: readonly any[], fallback = UNKNOWN_MODEL): Map<string, Usage> {
  const totals = new Map<string, Usage>();
  let current = fallback;
  for (const entry of entries) {
    if (entry.type === "model_change" && entry.provider && entry.modelId) {
      current = `${entry.provider}/${entry.modelId}`;
      continue;
    }
    let usage: Usage | undefined;
    let model = current;
    if (entry.type === "usage") {
      usage = entry.usage;
      if (entry.provider && entry.model) model = `${entry.provider}/${entry.model}`;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
    else if (entry.type === "message" && ["assistant", "toolResult"].includes(entry.message?.role)) {
      usage = entry.message.usage;
      if (entry.message.provider && entry.message.model) {
        model = `${entry.message.provider}/${entry.message.model}`;
        if (entry.message.role === "assistant") current = model;
      }
    }
    if (usage) addModelUsage(totals, model, usage);
  }
  return totals;
}

function nativeEntries(file: string | undefined): any[] | undefined {
  if (!file) return;
  try {
    const entries = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    if (entries[0]?.type === "session") return entries;
  } catch {
    return;
  }
}

/** Read only at run boundaries, never on a render frame. Unavailable files use event accounting. */
export function nativeSessionUsage(file: string | undefined): Usage | undefined {
  const entries = nativeEntries(file);
  if (entries) return sessionUsage(entries);
}

/** Each run stores a replacement snapshot, so progress, delivery and reload cannot double count it. */
export class ChildUsageLedger {
  private runs = new Map<string, Usage>();
  private runTasks = new Map<string, string>();
  private runModels = new Map<string, string>();
  private modelSums = new Map<string, Usage>();
  private sum = emptyUsage();

  get total(): Usage { return this.sum; }
  get byModel(): ModelUsage { return this.modelSums; }

  record(runId: string, usage: Partial<Usage>, taskId?: string, model?: string): boolean {
    if (taskId) this.runTasks.set(runId, taskId);
    const next = addUsage(emptyUsage(), usage);
    const previous = this.runs.get(runId);
    const previousModel = this.runModels.get(runId) ?? UNKNOWN_MODEL;
    const nextModel = model || previousModel;
    if (previous && previousModel === nextModel && JSON.stringify(previous) === JSON.stringify(next)) return false;
    this.runs.set(runId, next);
    this.runModels.set(runId, nextModel);
    if (previous) {
      for (const key of TOKEN_KEYS) this.sum[key] -= previous[key];
      for (const key of COST_KEYS) this.sum.cost[key] -= previous.cost[key];
      const modelTotal = this.modelSums.get(previousModel)!;
      for (const key of TOKEN_KEYS) modelTotal[key] -= previous[key];
      for (const key of COST_KEYS) modelTotal.cost[key] -= previous.cost[key];
      addUsage(modelTotal, undefined);
    }
    addUsage(this.sum, next);
    addModelUsage(this.modelSums, nextModel, next);
    return true;
  }

  restore(entries: readonly any[], tasks: readonly { taskId: string; sessionFile?: string }[] = []): void {
    this.runs.clear();
    this.runTasks.clear();
    this.runModels.clear();
    this.modelSums.clear();
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
                typeof result.taskId === "string" ? result.taskId : undefined,
                typeof result.model === "string" ? result.model : undefined);
          });
        }
      } else if (entry.customType === USAGE_ENTRY && typeof entry.data?.runId === "string" &&
        entry.data.usage && typeof entry.data.usage === "object") {
        this.record(entry.data.runId, entry.data.usage,
          typeof entry.data.taskId === "string" ? entry.data.taskId : undefined,
          typeof entry.data.model === "string" ? entry.data.model : undefined);
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
      const entries = nativeEntries(task.sessionFile);
      if (!entries) continue;
      const nativeModels = [...sessionModelUsage(entries)].filter(([, usage]) => usage.totalTokens > 0);
      const model = nativeModels.length === 1 ? nativeModels[0]![0] : UNKNOWN_MODEL;
      if (model !== UNKNOWN_MODEL) {
        for (const [runId, taskId] of this.runTasks)
          if (taskId === task.taskId && this.runModels.get(runId) === UNKNOWN_MODEL)
            this.record(runId, this.runs.get(runId)!, taskId, model);
      }
      this.record(`native:${task.taskId}`, usageDelta(sessionUsage(entries), known.get(task.taskId) ?? emptyUsage()),
        undefined, model);
    }
  }
}
