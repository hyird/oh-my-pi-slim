import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig, parseModel, type OmpConfig, type ThinkingLevel } from "./config.ts";
import { ROLES, isRole, type Role } from "./roles.ts";
import { startConversation } from "./transcript.ts";
import { ReplyAccumulator } from "./conversation-content.ts";
import { supportsServiceTier, type ServiceTier } from "./service-tier.ts";
import { availableChildModels } from "./models.ts";
import { RpcWorker } from "./rpc-worker.ts";
import { TaskSessions, resourceRevision, type TaskSession } from "./task-sessions.ts";

export interface Assignment { agent: Role; task: string; prompt?: string; instructions?: string; taskId?: string }
export interface Timings { startupMs: number; firstEventMs?: number; generationMs: number; toolMs: number; totalMs: number; deliveryMs?: number }
export interface Result { agent: Role; model: string; ok: boolean; output: string; usage: Usage; cancelled?: boolean; taskId?: string; runId?: string; timings?: Timings }
export interface AgentProgress {
  agent: Role;
  task: string;
  taskId?: string;
  runId?: string;
  conversationId?: string;
  /** Incremental, bounded assistant-only preview; present even before the first reply. */
  replyText?: string;
  model?: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  activity: string;
  text: string;
  activities: readonly string[];
  /** Confirmed output token throughput across assistant messages; tool time is excluded. */
  tokensPerSecond?: number;
}
export interface OmpDetails { progress: AgentProgress[]; results?: Result[]; jobId?: string; animationFrame?: number }
const MAX_OUTPUT = 20_000;

export function queuedProgress(items: readonly Assignment[]): AgentProgress[] {
  return items.map(({ agent, task, taskId }) => Object.freeze({
    agent, task, taskId, state: "queued", activity: "Waiting to run", text: "", activities: Object.freeze([]),
  }));
}

/** Only the two public upstream endpoints; no inherited imports or credentials. */
export function librarianMcpConfig() {
  return {
    mcpServers: {
      context7: { url: "https://mcp.context7.com/mcp", lifecycle: "eager" },
      gh_grep: { url: "https://mcp.grep.app", lifecycle: "eager" },
    },
    settings: {
      namespaceProxyTools: true, directTools: false, scriptMode: false,
      allowInstall: false, exposeResources: false,
    },
  };
}

const emptyUsage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export interface ModelSnapshot {
  config: OmpConfig;
  available: ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>;
}
export interface AgentLaunch { model: string; thinking?: ThinkingLevel; serviceTier?: ServiceTier; mcpAdapter?: boolean }

export function resolveLaunches(ctx: ExtensionContext, items: readonly Assignment[], snapshot: ModelSnapshot): ReadonlyMap<Role, AgentLaunch> {
  const launches = new Map<Role, AgentLaunch>();
  for (const { agent } of items) {
    if (launches.has(agent)) continue;
    launches.set(agent, {
      model: resolveModel(ctx, agent, snapshot),
      thinking: agent === "council" ? ctx.thinkingLevel : snapshot.config.thinking[agent] ?? ctx.thinkingLevel,
      serviceTier: snapshot.config.serviceTier?.[agent],
    });
  }
  return launches;
}

export function resolveModel(ctx: ExtensionContext, role: Role, snapshot: ModelSnapshot = { config: readConfig(), available: ctx.modelRegistry.getAvailable() }): string {
  const configured = role === "council" ? undefined : snapshot.config.models[role];
  const model = configured ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (!model) throw new Error(role === "council"
    ? "No main-session model to inherit; choose a model with Pi's /model"
    : "No model to inherit; use Pi's /model or configure a specialist model in /omp");
  const parsed = parseModel(model);
  const allowed = configured ? availableChildModels(ctx, snapshot.available) : snapshot.available;
  if (!parsed || !allowed.some((item) => item.provider === parsed.provider && item.id === parsed.id)) {
    throw new Error(role === "council"
      ? `Main-session model ${model} is unavailable; check /model and authentication`
      : `Model ${model} is not enabled or available; check /scoped-models, authentication, and the ${role} model setting in /omp`);
  }
  return model;
}

function invocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  if (!/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export const taskScope = (ctx: ExtensionContext) => JSON.stringify([path.resolve(ctx.cwd), ctx.isProjectTrusted()]);

// Keep provider extensions and trust enforcement inside an isolated, reusable Pi RPC process.
export async function runAgent(
  ctx: ExtensionContext, assignment: Assignment, signal?: AbortSignal,
  modelOverride?: string | AgentLaunch,
  onActivity?: (snapshot: AgentProgress) => void,
  sessions?: TaskSessions,
  resourceSnapshot?: string,
): Promise<Result> {
  const { agent, task } = assignment;
  if (!isRole(agent) || !task.trim()) throw new Error("A valid agent and nonempty task are required");
  if (signal?.aborted) throw new Error("Specialist tasks cancelled");
  const started = performance.now();
  const config = typeof modelOverride === "object" ? undefined : readConfig();
  const model = typeof modelOverride === "object" ? modelOverride.model : modelOverride ?? resolveModel(ctx, agent, {
    config: config!, available: ctx.modelRegistry.getAvailable(),
  });
  const thinking = typeof modelOverride === "object" ? modelOverride.thinking
    : agent === "council" ? ctx.thinkingLevel : config!.thinking[agent] ?? ctx.thinkingLevel;
  const tier = typeof modelOverride === "object" ? modelOverride.serviceTier : config?.serviceTier?.[agent];
  const serviceTier = agent !== "council" && supportsServiceTier(parseModel(model)?.provider) ? tier ?? "default" : undefined;
  const mcpAdapter = typeof modelOverride === "object" && modelOverride.mcpAdapter;
  const projectTrusted = ctx.isProjectTrusted();
  const prompt = assignment.prompt ?? ROLES[agent].prompt;
  const ownedSessions = sessions ?? new TaskSessions(0, 0);
  const signature = JSON.stringify([model, thinking, serviceTier, mcpAdapter, prompt, ROLES[agent].tools, resourceSnapshot ?? resourceRevision(ctx.cwd)]);
  const lease: TaskSession = ownedSessions.claim(assignment, taskScope(ctx), signature);
  const { taskId, runId } = lease;
  const progress: AgentProgress = {
    agent, task, taskId, runId, model, state: "running",
    activity: "Starting specialist", text: "", replyText: "", activities: Object.freeze([]),
  };
  const publish = () => { try { onActivity?.(Object.freeze({ ...progress })); } catch { /* presentation is best-effort */ } };
  const report = (activity: string) => {
    progress.activity = activity;
    progress.activities = Object.freeze([...progress.activities.slice(-31), activity]);
    publish();
  };
  const replies = new ReplyAccumulator();
  const usage = emptyUsage();
  const timings: Timings = { startupMs: 0, generationMs: 0, toolMs: 0, totalMs: 0 };
  let worker: RpcWorker | undefined;
  let conversation: ReturnType<typeof startConversation> | undefined;
  let recordingFailed = false;
  let output = "";
  let finalStop = "";
  let retryFailed = false;
  let streamingText = "";
  let messageStartedAt: number | undefined;
  let completedOutputTokens = 0;
  const toolStarts = new Map<string, number>();
  const updateThroughput = (partialOutput = 0, partialMs = 0) => {
    const tokens = completedOutputTokens + partialOutput;
    const duration = timings.generationMs + partialMs;
    progress.tokensPerSecond = tokens > 0 && duration > 0 ? tokens * 1000 / duration : undefined;
  };
  try {
    conversation = startConversation(agent, task, model, () => { recordingFailed = true; void worker?.stop(); });
    progress.conversationId = conversation.id;
    publish();
    worker = await ownedSessions.worker(lease, async (sessionDir, sessionFile) => {
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-omp-"));
      const cleanup = () => fs.promises.rm(tmpDir, { recursive: true, force: true });
      try {
        const promptPath = path.join(tmpDir, "role.md");
        await fs.promises.writeFile(promptPath, agent === "librarian" ? `${prompt}\nOnly mcp__context7 and mcp__gh_grep are permitted MCP tools. If either namespace is missing, report that the pi-mcp-adapter must be loaded and its eager metadata initialized; do not use mcp or mcpScript.\n` : prompt, { mode: 0o600 });
        const tools: string[] = [...ROLES[agent].tools];
        const mcpPath = agent === "librarian" || mcpAdapter ? path.join(tmpDir, "mcp.json") : undefined;
        if (mcpPath) {
          const mcpConfig = librarianMcpConfig();
          await fs.promises.writeFile(mcpPath, JSON.stringify(agent === "librarian" ? mcpConfig : { ...mcpConfig, mcpServers: {} }), { mode: 0o600, flag: "wx" });
        }
        if (agent === "librarian") tools.push("mcp__context7", "mcp__gh_grep");
        const args = [
          "--mode", "rpc", "--session-dir", sessionDir,
          ...(sessionFile ? ["--session", sessionFile] : ["--session-id", lease.taskId]),
          "--no-themes", "--no-prompt-templates",
          // Read-only scouting needs no skill catalog. Explicit task references can still be read.
          ...(["explorer", "librarian"].includes(agent) ? ["--no-skills"] : []),
          projectTrusted ? "--approve" : "--no-approve",
          "--model", model, ...(thinking ? ["--thinking", thinking] : []), "--tools", tools.join(","),
          ...(mcpPath ? ["--mcp-config", mcpPath] : []), "--append-system-prompt", promptPath,
        ];
        if (signal?.aborted) throw new Error("Specialist cancelled");
        const child = invocation(args);
        return new RpcWorker(child.command, child.args, ctx.cwd, {
          ...process.env, PI_OMP_CHILD: "1", PI_OMP_SERVICE_TIER: serviceTier,
          PI_MCP_CONFIG_MODE: mcpPath ? "exclusive" : undefined, MCP_DIRECT_TOOLS: undefined,
        }, cleanup);
      } catch (err) { await cleanup(); throw err; }
    });
    const abortStartup = () => { void worker!.stop(); };
    signal?.addEventListener("abort", abortStartup, { once: true });
    try {
      if (signal?.aborted) { abortStartup(); throw new Error("Specialist cancelled"); }
      await worker.ready;
    } finally { signal?.removeEventListener("abort", abortStartup); }
    timings.startupMs = performance.now() - started;
    // Dynamic task/language guidance stays outside the stable role system prompt.
    // A leading slash in task text must not execute a Pi slash/skill command.
    const message = `${assignment.instructions ? assignment.instructions + "\n\n" : ""}Assigned task:\n${task}`;
    await worker.prompt(message, signal, (event) => {
      try { conversation!.record(event); }
      catch { recordingFailed = true; throw new Error("Failed to save specialist conversation"); }
      replies.record(event);
      progress.replyText = replies.text();
      if (event.type === "auto_retry_start") {
        retryFailed = false;
        const attempt = Number.isSafeInteger(event.attempt) ? Math.max(0, event.attempt) : 0;
        const max = Number.isSafeInteger(event.maxAttempts) ? Math.max(0, event.maxAttempts) : 0;
        const delay = Number.isFinite(event.delayMs) ? Math.max(0, event.delayMs) : 0;
        report(`Retrying model request ${attempt}/${max} after ${delay >= 1000 ? `${Math.round(delay / 1000)}s` : `${Math.round(delay)}ms`}`);
        return;
      }
      if (event.type === "auto_retry_end") {
        const retryCancelled = event.finalError === "Retry cancelled";
        retryFailed = !event.success && !retryCancelled;
        report(event.success ? "Model request recovered" : retryCancelled ? "Model request retry cancelled" : "Model request failed after retry");
        return;
      }
      if (event.type === "message_start" && event.message?.role === "assistant") {
        messageStartedAt = performance.now();
        output = "";
        finalStop = "";
        return;
      }
      if (event.type === "message_update") {
        timings.firstEventMs ??= performance.now() - started;
        const update = event.assistantMessageEvent;
        messageStartedAt ??= performance.now();
        let changed = false;
        const partialOutput = event.usage?.output ?? update?.partial?.usage?.output;
        if (Number.isFinite(partialOutput) && partialOutput > 0) {
          updateThroughput(partialOutput, Math.max(1, performance.now() - messageStartedAt));
          changed = true;
        }
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          streamingText = (streamingText + update.delta).slice(-2000);
          progress.text = streamingText;
          changed = true;
        } else if (update?.type === "text_end" && typeof update.content === "string") {
          progress.text = update.content.slice(-2000);
          changed = true;
        }
        if (changed) publish();
        return;
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        toolStarts.set(event.toolCallId ?? event.toolName, performance.now());
        const args = event.args && typeof event.args === "object" ? event.args : {};
        const location = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
        report(location ? `${event.toolName.slice(0, 50)} ${location.slice(0, 100)}` : `${event.toolName.slice(0, 50)} running`);
        return;
      }
      if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
        const key = event.toolCallId ?? event.toolName;
        const start = toolStarts.get(key);
        if (start !== undefined) { timings.toolMs += performance.now() - start; toolStarts.delete(key); }
        report(`${event.toolName.slice(0, 50)} ${event.isError ? "failed" : "completed"}`);
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const msg = event.message;
      finalStop = msg.stopReason;
      const text = msg.content?.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n") ?? "";
      output = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated]` : text;
      progress.text = msg.stopReason === "error" || msg.stopReason === "aborted" ? "" : text.slice(-2000);
      streamingText = "";
      const u = msg.usage;
      if (u) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += u[key] ?? 0;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += u.cost?.[key] ?? 0;
        if (Number.isFinite(u.output) && u.output > 0 && messageStartedAt !== undefined) {
          completedOutputTokens += u.output;
          timings.generationMs += Math.max(1, performance.now() - messageStartedAt);
          updateThroughput();
        }
      }
      messageStartedAt = undefined;
      publish();
    });
    if (!output || finalStop !== "stop") throw new Error("Specialist run failed");
    timings.totalMs = performance.now() - started;
    try { conversation.finish("done", undefined, { taskId, runId, timings }); }
    catch (err) { recordingFailed = true; throw err; }
    // Release ownership only after settlement and durable recording, before publishing done.
    ownedSessions.release(lease);
    progress.state = "done";
    report("Work completed");
    return { agent, model, ok: true, output, usage, taskId, runId, timings };
  } catch (err) {
    await worker?.stop();
    const cancelled = signal?.aborted;
    const failure = cancelled ? "Specialist cancelled" : recordingFailed ? "Failed to save specialist conversation"
      : finalStop === "length" ? "Specialist response reached the model output limit. Inspect partial work before continuing."
      : err instanceof Error && err.message.includes("interactive input") ? err.message
      : retryFailed && finalStop === "error" ? "Model request failed after retry. Inspect partial work before continuing."
      : `Specialist run failed${agent === "librarian" ? "; check pi-mcp-adapter and context7/gh_grep eager metadata" : ""}`;
    timings.totalMs = performance.now() - started;
    try { conversation?.finish(cancelled ? "cancelled" : "failed", failure, { taskId, runId, timings }); }
    catch { recordingFailed = true; }
    ownedSessions.release(lease);
    progress.state = cancelled ? "cancelled" : "failed";
    report(cancelled ? "Cancelled" : "Run failed");
    return { agent, model, ok: false, cancelled, output: recordingFailed ? "Failed to save specialist conversation" : failure, usage,
      taskId, runId, timings };
  } finally {
    if (!sessions) await ownedSessions.clear();
  }
}
export async function runAssignments(
  ctx: ExtensionContext, items: Assignment[], signal?: AbortSignal,
  onProgress?: (snapshot: AgentProgress[]) => void,
  modelOverride?: string | ReadonlyMap<Role, AgentLaunch>,
  sessions?: TaskSessions,
  onComplete?: (result: Result, index: number) => void,
): Promise<Result[]> {
  const launches = typeof modelOverride === "object" ? modelOverride : undefined;
  const config = launches || signal?.aborted ? undefined : readConfig();
  const snapshot = config && { config, available: modelOverride ? [] : ctx.modelRegistry.getAvailable() };
  const resolved = new Map<Role, AgentLaunch>();
  let resourceSnapshot: string | undefined;
  const batchResources = () => resourceSnapshot ??= resourceRevision(ctx.cwd);
  const launchFor = (agent: Role): AgentLaunch => {
    if (launches) {
      const launch = launches.get(agent);
      if (!launch) throw new Error("Missing launch settings for " + agent);
      return launch;
    }
    let launch = resolved.get(agent);
    if (!launch) {
      launch = { model: typeof modelOverride === "string" ? modelOverride : resolveModel(ctx, agent, snapshot!),
        thinking: agent === "council" ? ctx.thinkingLevel : config!.thinking[agent] ?? ctx.thinkingLevel,
        serviceTier: config!.serviceTier?.[agent] };
      resolved.set(agent, launch);
    }
    return launch;
  };
  const results = new Array<Result>(items.length);
  const progress = queuedProgress(items);
  let lastPublished = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastPublished < 120) {
      timer ??= setTimeout(() => { timer = undefined; publish(true); }, 120 - (now - lastPublished));
      return;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastPublished = now;
    // Rows and activity lists are immutable snapshots. Copy only the outer
    // ordering array; unchanged agents retain their existing row identities.
    try { onProgress(progress.slice()); }
    catch { /* presentation is best-effort; keep supervising children */ }
  };
  publish(true);
  try {
    await Promise.all(items.map(async (item, index) => {
      try {
        if (signal?.aborted) throw new Error("Specialist tasks cancelled");
        results[index] = await runAgent(ctx, item, signal, launchFor(item.agent), (snapshot) => {
          const important = snapshot.activities !== progress[index].activities || snapshot.state !== progress[index].state;
          progress[index] = snapshot;
          publish(important);
        }, sessions, batchResources());
      } catch (err) {
        results[index] = {
          agent: item.agent, model: launches?.get(item.agent)?.model ?? resolved.get(item.agent)?.model ?? (typeof modelOverride === "string" ? modelOverride : "inherit"), ok: false, cancelled: signal?.aborted,
          output: signal?.aborted ? "Specialist cancelled" : err instanceof Error ? err.message : String(err), usage: emptyUsage(),
        };
      }
      const completed: AgentProgress = {
        ...progress[index], model: results[index].model, state: results[index].ok ? "done" : results[index].cancelled ? "cancelled" : "failed",
        activity: results[index].ok ? "Work completed" : results[index].cancelled ? "Cancelled" : "Run failed",
        text: results[index].ok ? results[index].output.slice(-2000) : progress[index].text,
      };
      const previous = progress[index];
      if (completed.model !== previous.model || completed.state !== previous.state ||
          completed.activity !== previous.activity || completed.text !== previous.text) {
        progress[index] = Object.freeze(completed);
        publish(true);
      }
      try { onComplete?.(results[index], index); }
      catch { /* A delivery callback must not abandon other running children. */ }
    }));
    return results;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatResults(results: Result[]): string {
  return results.map((result) => `${result.ok ? "OK" : result.cancelled ? "CANCELLED" : "FAILED"} ${result.agent} [${result.model}]${result.taskId ? ` taskId=${result.taskId} runId=${result.runId}` : ""}\n${result.output}`).join("\n\n---\n\n");
}
