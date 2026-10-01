import { isRole } from "./roles.ts";
import type { Assignment, Result } from "./subagents.ts";
import type { SavedTaskSession } from "./task-sessions.ts";

export const RECOVERY_ENTRY = "omp-recovery-v1";
export interface SavedJob {
  id: string;
  callId: string;
  kind: "delegate" | "council";
  items: Assignment[];
  results: Array<Result | null>;
  delivered: number[];
  active: boolean;
}
export interface RecoveryState {
  version: 1;
  parentId: string;
  scope: string;
  tasks: SavedTaskSession[];
  jobs: SavedJob[];
}

/** Validate private session entries before using them to launch processes. */
export function readRecovery(entries: readonly any[], parentId: string, scope: string): RecoveryState | undefined {
  const entry = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === RECOVERY_ENTRY);
  const data = entry?.data;
  if (!data || data.version !== 1 || data.parentId !== parentId || data.scope !== scope ||
    !Array.isArray(data.tasks) || !Array.isArray(data.jobs)) return;
  const ids = new Set<string>();
  const taskRoles = new Map<string, string>();
  for (const task of data.tasks) {
    if (!task || typeof task.taskId !== "string" || !/^[a-f0-9-]{36}$/.test(task.taskId) ||
      ids.has(task.taskId) || !isRole(task.agent) || task.agent === "orchestrator" || task.scope !== scope ||
      (task.sessionFile !== undefined && typeof task.sessionFile !== "string")) return;
    ids.add(task.taskId);
    taskRoles.set(task.taskId, task.agent);
  }
  for (const job of data.jobs) {
    if (!job || typeof job.id !== "string" || typeof job.callId !== "string" ||
      !["delegate", "council"].includes(job.kind) || typeof job.active !== "boolean" ||
      !Array.isArray(job.items) || !job.items.length || !Array.isArray(job.results) ||
      job.results.length !== job.items.length || !Array.isArray(job.delivered)) return;
    for (const item of job.items) {
      if (!item || !isRole(item.agent) || item.agent === "orchestrator" ||
        (job.kind === "council" ? item.agent !== "council" : item.agent === "council") ||
        typeof item.task !== "string" || !item.task.trim() ||
        (item.taskId !== undefined && (typeof item.taskId !== "string" || taskRoles.get(item.taskId) !== item.agent)) ||
        [item.instructions, item.prompt].some((value) => value !== undefined && typeof value !== "string")) return;
    }
    if (job.delivered.some((index: unknown) => !Number.isSafeInteger(index) ||
      (index as number) < 0 || (index as number) >= job.items.length || !job.results[index as number])) return;
    if (new Set(job.delivered).size !== job.delivered.length) return;
    for (const result of job.results) {
      if (result === null) continue;
      if (!result || !isRole(result.agent) || typeof result.model !== "string" ||
        typeof result.ok !== "boolean" || typeof result.output !== "string" ||
        !result.usage || !Number.isFinite(result.usage.totalTokens) || !result.usage.cost) return;
    }
  }
  return data as RecoveryState;
}
