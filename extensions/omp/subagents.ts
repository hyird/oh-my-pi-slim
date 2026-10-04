import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig, parseModel, type OmpConfig, type ThinkingLevel } from "./config.ts";
import { ROLES, isRole, type Role } from "./roles.ts";
import { startConversation } from "./transcript.ts";
import { ReplyAccumulator, safeText } from "./conversation-content.ts";
import { availableChildModels } from "./models.ts";
import { RpcWorker } from "./rpc-worker.ts";
import { TaskSessions, resourceRevision, type TaskSession } from "./task-sessions.ts";
import { failureDetail } from "./failure-detail.ts";
import { mergeRoleTools, type DcpToolSnapshot } from "./dcp-tools.ts";
import { addUsage, emptyUsage, nativeSessionUsage, usageDelta } from "./usage.ts";

export interface Assignment {
  agent: Role;
  task: string;
  prompt?: string;
  instructions?: string;
  taskId?: string;
}
export interface Timings {
  startupMs: number;
  firstEventMs?: number;
  generationMs: number;
  toolMs: number;
  totalMs: number;
  deliveryMs?: number;
}
export interface Result {
  agent: Role;
  model: string;
  ok: boolean;
  output: string;
  /** The model settled normally, but the report sent to the parent omits content. */
  outputTruncated?: boolean;
  usage: Usage;
  cancelled?: boolean;
  taskId?: string;
  runId?: string;
  timings?: Timings;
  dcpStatus?: string;
}
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
  /** Bounded tool-call summaries; only command/path arguments are retained, never result bodies. */
  operations?: readonly ToolOperation[];
  /** Confirmed output token throughput across assistant messages; tool time is excluded. */
  tokensPerSecond?: number;
  /** Safe, OMP-generated phase for the task row; never provider text or tool arguments. */
  phase?: "starting" | "model" | "tool" | "retrying" | "retry-failed" | "settling";
  retry?: Readonly<{ attempt: number; max: number; delayMs: number }>;
  /** Last child event received, including thinking updates that have no visible preview. */
  lastEventAt?: number;
  /** Current run's reported token usage, including cache tokens. */
  totalTokens?: number;
  /** Completed usage for this run; persisted separately from the streaming estimate. */
  usage?: Usage;
  streamingUsage?: Usage;
  /** Latest estimate reported by this child's configured DCP extension. */
  dcpStatus?: string;
  /** Wall-clock start for live display; elapsedMs freezes the duration once settled. */
  startedAt?: number;
  elapsedMs?: number;
}
export interface ToolOperation {
  id: string;
  name: string;
  invocation?: string;
  state: "running" | "done" | "failed";
  added?: number;
  removed?: number;
}

/** Keep only locating arguments: edits may also carry complete file contents. */
function toolInvocation(name: string, args: Record<string, unknown>): string {
  const text = (key: string) => typeof args[key] === "string" ? safeText(args[key]) : "";
  const command = text("command") || text("cmd") || text("script");
  if (command) return `${name} ${command}`;
  const target = text("path") || text("file_path");
  if (name === "grep" || name === "find") {
    const pattern = text("pattern");
    const glob = name === "grep" ? text("glob") : "";
    return [name, pattern, target, glob].filter(Boolean).join(" ");
  }
  return [name, target].filter(Boolean).join(" ");
}
export interface OmpDetails {
  progress: AgentProgress[];
  results?: Result[];
  jobId?: string;
  animationFrame?: number;
}
const MAX_OUTPUT = 20_000;

function boundedReport(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  // Keep final caveats/check outcomes as well as the initial findings. Neither
  // slice is a substitute for the full recording or acceptance verification.
  const marker = "\n[output truncated] OMP omitted the middle of this report.\n";
  const available = MAX_OUTPUT - marker.length;
  let head = Math.floor(available / 2);
  let tail = text.length - (available - head);
  // Avoid introducing unpaired UTF-16 surrogates at either cut.
  if (text.charCodeAt(head - 1) >= 0xd800 && text.charCodeAt(head - 1) <= 0xdbff) head--;
  if (text.charCodeAt(tail) >= 0xdc00 && text.charCodeAt(tail) <= 0xdfff) tail++;
  return text.slice(0, head) + marker + text.slice(tail);
}

const SIMPLIFY_SKILL_PATH = fileURLToPath(
  new URL("../../skills/simplify/SKILL.md", import.meta.url),
);
const CHILD_MCP_EXTENSION_PATH = fileURLToPath(new URL("./child-mcp.ts", import.meta.url));

export function queuedProgress(items: readonly Assignment[]): AgentProgress[] {
  return items.map(({ agent, task, taskId }) =>
    Object.freeze({
      agent,
      task,
      taskId,
      state: "queued",
      activity: "Waiting to run",
      text: "",
      activities: Object.freeze([]),
      operations: Object.freeze([]),
    }),
  );
}

/** Count changed lines from Pi's edit metadata without retaining the diff text. */
export function editLineCounts(result: unknown): { added: number; removed: number } | undefined {
  const details = result && typeof result === "object"
    ? (result as { details?: unknown }).details
    : undefined;
  if (!details || typeof details !== "object") return undefined;
  const { diff, patch } = details as { diff?: unknown; patch?: unknown };
  const displayDiff = typeof diff === "string";
  const source = displayDiff ? diff : typeof patch === "string" ? patch : undefined;
  if (source === undefined) return undefined;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of source.split("\n")) {
    if (displayDiff) {
      if (/^\+\s*\d+ /.test(line)) added++;
      else if (/^-\s*\d+ /.test(line)) removed++;
    } else {
      if (line.startsWith("@@")) inHunk = true;
      else if (inHunk && line.startsWith("+")) added++;
      else if (inHunk && line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

export interface ModelSnapshot {
  config: OmpConfig;
  available: ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>;
}
export interface AgentLaunch {
  model: string;
  thinking?: ThinkingLevel;
}

export function resolveLaunches(
  ctx: ExtensionContext,
  items: readonly Assignment[],
  snapshot: ModelSnapshot,
): ReadonlyMap<Role, AgentLaunch> {
  const launches = new Map<Role, AgentLaunch>();
  for (const { agent } of items) {
    if (launches.has(agent)) continue;
    launches.set(agent, {
      model: resolveModel(ctx, agent, snapshot),
      thinking:
        agent === "council"
          ? ctx.thinkingLevel
          : (snapshot.config.thinking[agent] ?? ctx.thinkingLevel),
    });
  }
  return launches;
}

export function resolveModel(
  ctx: ExtensionContext,
  role: Role,
  snapshot: ModelSnapshot = { config: readConfig(), available: ctx.modelRegistry.getAvailable() },
): string {
  const configured = role === "council" ? undefined : snapshot.config.models[role];
  const model = configured ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (!model)
    throw new Error(
      role === "council"
        ? "No main-session model to inherit; choose a model with Pi's /model"
        : "No model to inherit; use Pi's /model or configure a specialist model in /omp",
    );
  const parsed = parseModel(model);
  const allowed = configured ? availableChildModels(ctx, snapshot.available) : snapshot.available;
  if (
    !parsed ||
    !allowed.some((item) => item.provider === parsed.provider && item.id === parsed.id)
  ) {
    throw new Error(
      role === "council"
        ? `Main-session model ${model} is unavailable; check /model and authentication`
        : `Model ${model} is not enabled or available; check /scoped-models, authentication, and the ${role} model setting in /omp`,
    );
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

export const taskScope = (ctx: ExtensionContext) =>
  JSON.stringify([path.resolve(ctx.cwd), ctx.isProjectTrusted()]);

// Keep provider extensions and trust enforcement inside an isolated, reusable Pi RPC process.
export async function runAgent(
  ctx: ExtensionContext,
  assignment: Assignment,
  signal?: AbortSignal,
  modelOverride?: string | AgentLaunch,
  onActivity?: (snapshot: AgentProgress) => void,
  sessions?: TaskSessions,
  resourceSnapshot?: string,
  dcpSnapshot: DcpToolSnapshot = { providers: [], tools: [], signature: "[]" },
): Promise<Result> {
  const { agent, task } = assignment;
  if (!isRole(agent) || !task.trim())
    throw new Error("A valid agent and nonempty task are required");
  if (signal?.aborted) throw new Error("Specialist tasks cancelled");
  const started = performance.now();
  const startedAt = Date.now();
  const config = typeof modelOverride === "object" ? undefined : readConfig();
  const model =
    typeof modelOverride === "object"
      ? modelOverride.model
      : (modelOverride ??
        resolveModel(ctx, agent, {
          config: config!,
          available: ctx.modelRegistry.getAvailable(),
        }));
  const thinking =
    typeof modelOverride === "object"
      ? modelOverride.thinking
      : agent === "council"
        ? ctx.thinkingLevel
        : (config!.thinking[agent] ?? ctx.thinkingLevel);
  const projectTrusted = ctx.isProjectTrusted();
  const prompt = assignment.prompt ?? ROLES[agent].prompt;
  const ownedSessions = sessions ?? new TaskSessions(0, 0);
  const signature = JSON.stringify([
    model,
    thinking,
    prompt,
    ROLES[agent].tools,
    dcpSnapshot.signature,
    resourceSnapshot ?? resourceRevision(ctx.cwd),
  ]);
  const lease: TaskSession = ownedSessions.claim(assignment, taskScope(ctx), signature);
  const { taskId, runId } = lease;
  const progress: AgentProgress = {
    agent,
    task,
    taskId,
    runId,
    model,
    state: "running",
    activity: "Starting specialist",
    text: "",
    replyText: "",
    activities: Object.freeze([]),
    operations: Object.freeze([]),
    phase: "starting",
    lastEventAt: Date.now(),
    startedAt,
    totalTokens: 0,
  };
  let lastPublishedAt = 0;
  const publish = () => {
    lastPublishedAt = Date.now();
    try {
      onActivity?.(Object.freeze({ ...progress }));
    } catch {
      /* presentation is best-effort */
    }
  };
  const report = (activity: string) => {
    progress.activity = activity;
    progress.activities = Object.freeze([...progress.activities.slice(-31), activity]);
    publish();
  };
  const recordOperation = (operation: ToolOperation) => {
    progress.operations = Object.freeze([
      ...(progress.operations ?? []).slice(-31),
      Object.freeze(operation),
    ]);
  };
  const finishOperation = (id: string, name: string, failed: boolean, result: unknown) => {
    const operations = [...(progress.operations ?? [])];
    let index = -1;
    for (let i = operations.length - 1; i >= 0; i--)
      if (operations[i].id === id && operations[i].state === "running") {
        index = i;
        break;
      }
    const counts = !failed && name === "edit" ? editLineCounts(result) : undefined;
    const finished = Object.freeze({
      ...(index >= 0 ? operations[index] : {}),
      id,
      name,
      state: failed ? "failed" as const : "done" as const,
      ...counts,
    });
    if (index < 0) operations.push(finished);
    else operations[index] = finished;
    progress.operations = Object.freeze(operations.slice(-32));
  };
  const replies = new ReplyAccumulator();
  const usage = emptyUsage();
  const timings: Timings = { startupMs: 0, generationMs: 0, toolMs: 0, totalMs: 0 };
  let worker: RpcWorker | undefined;
  let baseline: Usage | undefined;
  const publishUsage = () => {
    progress.usage = structuredClone(usage);
    progress.streamingUsage = undefined;
    progress.totalTokens = usage.totalTokens;
    publish();
  };
  const reconcileUsage = () => {
    const native = nativeSessionUsage(worker?.sessionFile);
    if (!native || !baseline) return;
    const delta = usageDelta(native, baseline);
    // Keep reported events when a cancelled/failed process did not flush its last message.
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
      usage[key] = Math.max(usage[key], delta[key]);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
      usage.cost[key] = Math.max(usage.cost[key], delta.cost[key]);
    addUsage(usage, undefined);
    publishUsage();
  };
  let conversation: ReturnType<typeof startConversation> | undefined;
  let recordingFailed = false;
  let recordingError: string | undefined;
  let output = "";
  let outputTruncated = false;
  let finalStop = "";
  let retryFailed = false;
  let failureReason: string | undefined;
  let retryError: string | undefined;
  let streamingText = "";
  let messageStartedAt: number | undefined;
  let completedOutputTokens = 0;
  const toolStarts = new Map<string, number>();
  const updateThroughput = (partialOutput = 0, partialMs = 0) => {
    const tokens = completedOutputTokens + partialOutput;
    const duration = timings.generationMs + partialMs;
    progress.tokensPerSecond = tokens > 0 && duration > 0 ? (tokens * 1000) / duration : undefined;
  };
  try {
    conversation = startConversation(agent, task, model, (err) => {
      recordingFailed = true;
      recordingError ??= failureDetail(err);
      void worker?.stop();
    });
    lease.discardRecordings.add(conversation.discard);
    progress.conversationId = conversation.id;
    publish();
    worker = await ownedSessions.worker(lease, async (sessionDir, sessionFile) => {
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-omp-"));
      const cleanup = () => fs.promises.rm(tmpDir, { recursive: true, force: true });
      try {
        const promptPath = path.join(tmpDir, "role.md");
        await fs.promises.writeFile(
          promptPath,
          agent === "librarian"
            ? `${prompt}\nUse only mcp({server:'gh_grep',tool:'search',args:{...}}) for MCP. Direct MCP calls are blocked; context7, codemode, tool_search, and mcpScript are not available. If the scoped gateway is unavailable, report that clearly and continue with read/websearch where useful.\n`
            : prompt,
          { mode: 0o600 },
        );
        const tools = mergeRoleTools(
          agent === "librarian"
            ? [...ROLES[agent].tools, "mcp", "mcp__gh_grep__searchGitHub"]
            : ROLES[agent].tools,
          dcpSnapshot.tools,
        );
        const args = [
          "--mode",
          "rpc",
          "--session-dir",
          sessionDir,
          ...(sessionFile ? ["--session", sessionFile] : ["--session-id", lease.taskId]),
          "--no-themes",
          "--no-prompt-templates",
          // Council inherits the main session's skills. Specialists use only
          // their assigned skills; Oracle gets the bundled simplify skill.
          ...(agent !== "council" ? ["--no-skills"] : []),
          ...(agent === "oracle" ? ["--skill", SIMPLIFY_SKILL_PATH] : []),
          projectTrusted ? "--approve" : "--no-approve",
          "--model",
          model,
          ...(thinking ? ["--thinking", thinking] : []),
          "--tools",
          tools.join(","),
          "--extension",
          CHILD_MCP_EXTENSION_PATH,
          ...dcpSnapshot.providers.flatMap((provider) => ["--extension", provider.path]),
          "--append-system-prompt",
          promptPath,
        ];
        if (signal?.aborted) throw new Error("Specialist cancelled");
        const child = invocation(args);
        return new RpcWorker(
          child.command,
          child.args,
          ctx.cwd,
          {
            ...process.env,
            PI_OMP_CHILD: "1",
            PI_OMP_CHILD_ROLE: agent,
            PI_OMP_DCP_TOOLS: JSON.stringify(dcpSnapshot.providers),
          },
          cleanup,
          undefined,
          undefined,
          CHILD_MCP_EXTENSION_PATH,
          dcpSnapshot.providers.map((provider) => provider.path),
        );
      } catch (err) {
        await cleanup();
        throw err;
      }
    });
    const abortStartup = () => {
      void worker!.stop();
    };
    signal?.addEventListener("abort", abortStartup, { once: true });
    try {
      if (signal?.aborted) {
        abortStartup();
        throw new Error("Specialist cancelled");
      }
      await worker.ready;
      baseline = nativeSessionUsage(worker.sessionFile) ?? emptyUsage();
    } finally {
      signal?.removeEventListener("abort", abortStartup);
    }
    timings.startupMs = performance.now() - started;
    if (worker.dcpStatus !== progress.dcpStatus) {
      progress.dcpStatus = worker.dcpStatus;
      publish();
    }
    // Dynamic task/language guidance stays outside the stable role system prompt.
    // A leading slash in task text must not execute a Pi slash/skill command.
    const message = `${assignment.instructions ? assignment.instructions + "\n\n" : ""}Assigned task:\n${task}`;
    await worker.prompt(message, signal, (event) => {
      progress.lastEventAt = Date.now();
      try {
        conversation!.record(event);
      } catch (err) {
        recordingFailed = true;
        throw new Error("Failed to save specialist conversation", { cause: err });
      }
      replies.record(event);
      progress.replyText = replies.text();
      if (event.type === "extension_ui_request" && event.method === "setStatus" &&
        event.statusKey === "dcp") {
        progress.dcpStatus = worker!.dcpStatus;
        publish();
        return;
      }
      if (event.type === "auto_retry_start") {
        retryFailed = false;
        const attempt = Number.isSafeInteger(event.attempt) ? Math.max(0, event.attempt) : 0;
        const max = Number.isSafeInteger(event.maxAttempts) ? Math.max(0, event.maxAttempts) : 0;
        const delay = Number.isFinite(event.delayMs) ? Math.max(0, event.delayMs) : 0;
        progress.phase = "retrying";
        progress.retry = Object.freeze({ attempt, max, delayMs: delay });
        report(
          `Retrying model request ${attempt}/${max} after ${delay >= 1000 ? `${Math.round(delay / 1000)}s` : `${Math.round(delay)}ms`}`,
        );
        return;
      }
      if (event.type === "auto_retry_end") {
        const retryCancelled = event.finalError === "Retry cancelled";
        retryFailed = !event.success && !retryCancelled;
        retryError = !event.success ? failureDetail(event.finalError) : undefined;
        progress.phase = event.success ? "model" : "retry-failed";
        progress.retry = undefined;
        report(
          event.success
            ? "Model request recovered"
            : retryCancelled
              ? "Model request retry cancelled"
              : "Model request failed after retry",
        );
        return;
      }
      if (event.type === "message_start" && event.message?.role === "assistant") {
        messageStartedAt = performance.now();
        failureReason = undefined;
        output = "";
        outputTruncated = false;
        finalStop = "";
        progress.phase = "model";
        progress.retry = undefined;
        progress.totalTokens = usage.totalTokens;
        progress.streamingUsage = undefined;
        publish();
        return;
      }
      if (event.type === "message_update") {
        timings.firstEventMs ??= performance.now() - started;
        const update = event.assistantMessageEvent;
        messageStartedAt ??= performance.now();
        let changed = false;
        const partialUsage = event.message?.usage ?? update?.partial?.usage ?? event.usage;
        if (Number.isFinite(partialUsage?.totalTokens) && partialUsage.totalTokens >= 0) {
          progress.totalTokens = usage.totalTokens + partialUsage.totalTokens;
          progress.streamingUsage = addUsage(emptyUsage(), partialUsage);
          changed = true;
        }
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
        if (changed || Date.now() - lastPublishedAt >= 10_000) publish();
        return;
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        progress.phase = "tool";
        toolStarts.set(event.toolCallId ?? event.toolName, performance.now());
        const name = safeText(event.toolName).slice(0, 50) || "tool";
        const args = event.args && typeof event.args === "object" ? event.args : {};
        recordOperation({
          id: event.toolCallId ?? event.toolName,
          name,
          invocation: toolInvocation(name, args),
          state: "running",
        });
        const location =
          typeof args.path === "string"
            ? args.path
            : typeof args.file_path === "string"
              ? args.file_path
              : "";
        report(
          location
            ? `${event.toolName.slice(0, 50)} ${location.slice(0, 100)}`
            : `${event.toolName.slice(0, 50)} running`,
        );
        return;
      }
      if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
        progress.phase = "model";
        const key = event.toolCallId ?? event.toolName;
        const start = toolStarts.get(key);
        if (start !== undefined) {
          timings.toolMs += performance.now() - start;
          toolStarts.delete(key);
        }
        finishOperation(
          key,
          safeText(event.toolName).slice(0, 50) || "tool",
          !!event.isError,
          event.result,
        );
        report(`${event.toolName.slice(0, 50)} ${event.isError ? "failed" : "completed"}`);
        return;
      }
      if (event.type === "agent_settled") {
        progress.phase = "settling";
        publish();
        return;
      }
      if (event.type === "message_end" && event.message?.role === "toolResult" && event.message.usage) {
        addUsage(usage, event.message.usage);
        publishUsage();
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const msg = event.message;
      finalStop = msg.stopReason;
      failureReason = failureDetail(msg.errorMessage);
      progress.phase = msg.stopReason === "error" ? "retry-failed" : "model";
      const text =
        msg.content
          ?.filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text)
          .join("\n") ?? "";
      const hasText = !!text.trim();
      outputTruncated = hasText && text.length > MAX_OUTPUT;
      output = hasText ? boundedReport(text) : "";
      progress.text =
        msg.stopReason === "error" || msg.stopReason === "aborted" ? "" : text.slice(-2000);
      streamingText = "";
      const u = msg.usage;
      if (u) {
        addUsage(usage, u);
        if (Number.isFinite(u.output) && u.output > 0 && messageStartedAt !== undefined) {
          completedOutputTokens += u.output;
          timings.generationMs += Math.max(1, performance.now() - messageStartedAt);
          updateThroughput();
        }
      }
      messageStartedAt = undefined;
      publishUsage();
    });
    reconcileUsage();
    if (!output || finalStop !== "stop") {
      throw new Error(failureReason ?? (output ? `Assistant stopped: ${finalStop || "unknown"}` : "Assistant returned no output"));
    }
    timings.totalMs = performance.now() - started;
    try {
      conversation.finish("done", undefined, { taskId, runId, timings });
    } catch (err) {
      recordingFailed = true;
      throw err;
    }
    // Release ownership only after settlement and durable recording, before publishing done.
    ownedSessions.release(lease);
    progress.state = "done";
    progress.elapsedMs = timings.totalMs;
    report("Work completed");
    return { agent, model, ok: true, output, ...(outputTruncated ? { outputTruncated: true } : {}), usage, taskId, runId, timings, dcpStatus: progress.dcpStatus };
  } catch (err) {
    await worker?.stop();
    reconcileUsage();
    publishUsage();
    const cancelled = signal?.aborted;
    const thrownDetail = failureDetail(err);
    const modelDetail = failureDetail(failureReason);
    const retryDetail = failureDetail(retryError);
    const detail = [...new Set([recordingError, thrownDetail, retryDetail, modelDetail].filter(Boolean))].join("; ");
    const suffix = detail ? `: ${detail}` : "";
    let failure = cancelled
      ? `Specialist cancelled${suffix}`
      : recordingFailed
        ? `Failed to save specialist conversation${suffix}`
        : finalStop === "length"
          ? `Specialist response reached the model output limit. Inspect partial work before continuing.${suffix}`
          : failureDetail(err)?.includes("interactive input")
            ? `${failureDetail(err)}${suffix && !failureDetail(err)?.includes(modelDetail ?? "\0") ? suffix : ""}`
            : retryFailed && finalStop === "error"
              ? `Model request failed after retry. Inspect partial work before continuing.${suffix}`
              : `Specialist run failed${agent === "librarian" ? "; check the isolated native gh_grep MCP connector or use read/websearch" : ""}${suffix}`;
    timings.totalMs = performance.now() - started;
    try {
      conversation?.finish(cancelled ? "cancelled" : "failed", failure, { taskId, runId, timings });
    } catch (err) {
      recordingFailed = true;
      recordingError ??= failureDetail(err);
      if (recordingError && !failure.includes(recordingError))
        failure = `${failure}; conversation log write failed: ${recordingError}`;
    }
    ownedSessions.release(lease);
    progress.state = cancelled ? "cancelled" : "failed";
    progress.elapsedMs = timings.totalMs;
    report(cancelled ? "Cancelled" : "Run failed");
    return {
      agent,
      model,
      ok: false,
      cancelled,
      output: failure,
      usage,
      taskId,
      runId,
      timings,
      dcpStatus: progress.dcpStatus,
    };
  } finally {
    if (!sessions) await ownedSessions.clear();
  }
}
export async function runAssignments(
  ctx: ExtensionContext,
  items: Assignment[],
  signal?: AbortSignal,
  onProgress?: (snapshot: AgentProgress[]) => void,
  modelOverride?: string | ReadonlyMap<Role, AgentLaunch>,
  sessions?: TaskSessions,
  onComplete?: (result: Result, index: number) => void,
  dcpSnapshot: DcpToolSnapshot = { providers: [], tools: [], signature: "[]" },
): Promise<Result[]> {
  const launches = typeof modelOverride === "object" ? modelOverride : undefined;
  const config = launches || signal?.aborted ? undefined : readConfig();
  const snapshot = config && {
    config,
    available: modelOverride ? [] : ctx.modelRegistry.getAvailable(),
  };
  const resolved = new Map<Role, AgentLaunch>();
  let resourceSnapshot: string | undefined;
  const batchResources = () => (resourceSnapshot ??= resourceRevision(ctx.cwd));
  const launchFor = (agent: Role): AgentLaunch => {
    if (launches) {
      const launch = launches.get(agent);
      if (!launch) throw new Error("Missing launch settings for " + agent);
      return launch;
    }
    let launch = resolved.get(agent);
    if (!launch) {
      launch = {
        model:
          typeof modelOverride === "string" ? modelOverride : resolveModel(ctx, agent, snapshot!),
        thinking:
          agent === "council" ? ctx.thinkingLevel : (config!.thinking[agent] ?? ctx.thinkingLevel),
      };
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
    const now = performance.now();
    if (!force && now - lastPublished < 120) {
      timer ??= setTimeout(
        () => {
          timer = undefined;
          publish(true);
        },
        120 - (now - lastPublished),
      );
      return;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastPublished = now;
    // Rows, activity lists, and operation summaries are immutable snapshots.
    // Copy only the outer ordering array; unchanged rows keep their identities.
    try {
      onProgress(progress.slice());
    } catch {
      /* presentation is best-effort; keep supervising children */
    }
  };
  publish(true);
  try {
    await Promise.all(
      items.map(async (item, index) => {
        try {
          if (signal?.aborted) throw new Error("Specialist tasks cancelled");
          results[index] = await runAgent(
            ctx,
            item,
            signal,
            launchFor(item.agent),
            (snapshot) => {
              const important =
                snapshot.activities !== progress[index].activities ||
                snapshot.state !== progress[index].state ||
                snapshot.usage !== progress[index].usage;
              progress[index] = snapshot;
              publish(important);
            },
            sessions,
            batchResources(),
            dcpSnapshot,
          );
        } catch (err) {
          results[index] = {
            agent: item.agent,
            model:
              launches?.get(item.agent)?.model ??
              resolved.get(item.agent)?.model ??
              (typeof modelOverride === "string" ? modelOverride : "inherit"),
            ok: false,
            cancelled: signal?.aborted,
            output: signal?.aborted
              ? "Specialist cancelled"
              : err instanceof Error
                ? err.message
                : String(err),
            usage: emptyUsage(),
          };
        }
        const completed: AgentProgress = {
          ...progress[index],
          model: results[index].model,
          state: results[index].ok ? "done" : results[index].cancelled ? "cancelled" : "failed",
          activity: results[index].ok
            ? "Work completed"
            : results[index].cancelled
              ? "Cancelled"
              : "Run failed",
          text: results[index].ok ? results[index].output.slice(-2000) : progress[index].text,
        };
        const previous = progress[index];
        if (
          completed.model !== previous.model ||
          completed.state !== previous.state ||
          completed.activity !== previous.activity ||
          completed.text !== previous.text
        ) {
          progress[index] = Object.freeze(completed);
          publish(true);
        }
        try {
          onComplete?.(results[index], index);
        } catch {
          /* A delivery callback must not abandon other running children. */
        }
      }),
    );
    return results;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatResults(results: Result[]): string {
  return results
    .map(
      (result) =>
        `${result.ok ? "OK" : result.cancelled ? "CANCELLED" : "FAILED"} ${result.agent} [${result.model}]${result.taskId ? ` taskId=${result.taskId} runId=${result.runId}` : ""}\n${result.outputTruncated ? "[OMP: shortened report, not complete acceptance evidence. Inspect the full recording or request a concise taskId follow-up.]\n" : ""}${result.output}`,
    )
    .join("\n\n---\n\n");
}
