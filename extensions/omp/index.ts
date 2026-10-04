import { randomUUID } from "node:crypto";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Container } from "@earendil-works/pi-tui";
import { configPath, isThinkingLevel, parseModel, readConfig, updateConfig } from "./config.ts";
import { ROLES, ROLE_NAMES, isMainAgent, isRole, type MainAgent, type Role } from "./roles.ts";
import { showSettingsUi, INHERIT, INHERIT_THINKING, parseRoleSettingValue } from "./settings-ui.ts";
import {
  formatResults,
  queuedProgress,
  resolveLaunches,
  runAssignments,
  taskScope,
  type AgentProgress,
  type Assignment,
  type OmpDetails,
  type Result,
  type AgentLaunch,
  type ModelSnapshot,
} from "./subagents.ts";
import { TaskSessions } from "./task-sessions.ts";
import {
  formatTokenRate,
  OMP_SPINNER_FRAMES,
  paintPinnedBackground,
  renderPinnedOmpOverview,
  renderPinnedOmpDetail,
  renderOmpToolCall,
  renderOmpToolResult,
  type OmpRenderState,
  type PinnedOmpBatch,
} from "./render.ts";
import { prepareAssignments } from "./language.ts";
import { registerWebSearch } from "./websearch.ts";
import { installMcpPolicy } from "./mcp-policy.ts";
import { availableChildModels } from "./models.ts";
import { failureDetail } from "./failure-detail.ts";
import { discoverDcpTools } from "./dcp-tools.ts";
import { ChildUsageLedger, USAGE_ENTRY, addUsage, addModelUsage, emptyUsage } from "./usage.ts";
import { installUsageFooter, OMP_STATUS_KEY } from "./footer.ts";
import { scrollablePinnedCard, type PinnedScrollState } from "./pinned-scroll.ts";

const COUNCIL_PERSPECTIVES = [
  "Find failure modes, safety issues, and counterexamples.",
  "Assess architecture, feasibility, and maintenance trade-offs.",
  "Find the simplest acceptable option and evaluate opportunity cost.",
];
const councilAssignments = (question: string): Assignment[] =>
  COUNCIL_PERSPECTIVES.map((perspective) => ({
    agent: "council",
    task: `${perspective}\n\nDecision: ${question}`,
  }));

type BackgroundJob = {
  id: string;
  callId: string;
  kind: "delegate" | "council";
  session: number;
  state: "running" | "done" | "failed" | "cancelled";
  progress: AgentProgress[];
  results?: Result[];
  controller: AbortController;
  invalidators: Map<string, () => void>;
  pinnedState: OmpRenderState;
  displayOrder: number;
  released: boolean;
  animationFrame: number;
  deliveryTimer?: ReturnType<typeof setTimeout>;
};

type PendingCall = { tasks: Assignment[]; state: OmpRenderState; displayOrder: number };
type PendingDelivery = {
  session: number;
  content: string;
  attempts: number;
  wake: boolean;
  retryAt?: number;
  completed?: Array<{ result: Result; at: number }>;
};

type OmpRuntime = {
  session: number;
  jobs: Map<string, BackgroundJob>;
  jobsByCall: Map<string, BackgroundJob>;
  running: Set<BackgroundJob>;
  pinned: Set<BackgroundJob>;
  calls: Map<string, PendingCall>;
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
  pending: PendingDelivery[];
  retryTimer?: ReturnType<typeof setTimeout>;
  scroll: PinnedScrollState;
  animationTimer?: ReturnType<typeof setInterval>;
  requestPinnedRender?: () => void;
  pinnedUiAvailable: boolean;
  dirtyJobs: Set<BackgroundJob>;
  nextDisplayOrder: number;
};

export default function omp(pi: ExtensionAPI) {
  registerWebSearch(pi);
  // Child sessions need personal provider extensions but must not register OMP again.
  if (process.env.PI_OMP_CHILD === "1") return;
  let role: MainAgent = "orchestrator";
  let mainMessageStartedAt: number | undefined;
  let mainOutputTokens = 0;
  let mainGenerationMs = 0;
  let mainTokenRate: number | undefined;
  let lastRateStatusAt = 0;
  // Each extension instance owns its jobs. Reloading disposes this instance and
  // cancels its children; no cross-version runtime state is shared.
  const runtime: OmpRuntime = {
    session: 0,
    jobs: new Map(),
    jobsByCall: new Map(),
    running: new Set(),
    pinned: new Set(),
    calls: new Map(),
    pending: [],
    dirtyJobs: new Set(),
    nextDisplayOrder: 0,
    scroll: { listTop: 0, detailTop: 0 },
    pinnedUiAvailable: false,
  };
  const jobs = runtime.jobs;
  const calls = runtime.calls;
  const sessions = new TaskSessions();
  const childUsage = new ChildUsageLedger();
  let mainStreamingUsage = emptyUsage();
  let requestFooterRender = () => {};
  let footerModels: string[] = [];
  const recordUsage = (runId: string | undefined, usage: Result["usage"] | undefined, taskId?: string, model?: string) => {
    if (!runId || !usage || !childUsage.record(runId, usage, taskId, model)) return;
    if (runtime.ctx?.sessionManager?.getSessionId?.()) {
      try { pi.appendEntry(USAGE_ENTRY, { runId, taskId, model, usage: structuredClone(usage) }); }
      catch (err) { warn(runtime.ctx, `OMP: could not save token usage: ${failureDetail(err) ?? "unknown error"}`); }
    }
    requestFooterRender();
  };
  const restoreUsageFooter = (ctx: ExtensionContext) => {
    try { ctx.ui.setStatus("omp", undefined); } catch { /* Stale UI. */ }
    childUsage.restore(ctx.sessionManager.getEntries());
    requestFooterRender = installUsageFooter(ctx, childUsage, () => {
      const live = new Map();
      if (ctx.model) addModelUsage(live, `${ctx.model.provider}/${ctx.model.id}`, mainStreamingUsage);
      for (const job of runtime.running)
        for (const row of job.progress)
          if (row.state === "running" && row.model && row.streamingUsage) addModelUsage(live, row.model, row.streamingUsage);
      return live;
    }, () => pi.getThinkingLevel(), () => footerModels);
  };
  const liveCalls = new Set<string>();
  let acceptingWork = true;
  let dispatchRevision = 0;
  let parentSignal: AbortSignal | undefined;
  let compactionSignal: AbortSignal | undefined;
  const backgroundWaiters = new Set<() => void>();
  let deliveryRevision = 0;
  let observedDeliveryRevision = 0;
  let inputRevision = 0;
  let observedInputRevision = 0;
  const releaseBackgroundWaiters = () => {
    for (const finish of [...backgroundWaiters]) finish();
  };
  const reconcileTools = installMcpPolicy(pi, () => role);
  const warn = (ctx: ExtensionContext, message: string) => {
    try {
      ctx.ui.notify(message, "warning");
    } catch {
      /* A stale notification UI must not interrupt model reconciliation. */
    }
  };

  const reconcileModels = async (
    ctx: ExtensionContext,
    canCommit: () => boolean = () => true,
  ): Promise<ModelSnapshot> => {
    const snapshot: ModelSnapshot = {
      config: readConfig(),
      available: ctx.modelRegistry.getAvailable(),
    };
    if (canCommit()) footerModels = Object.values(snapshot.config.models);
    const available = availableChildModels(ctx, snapshot.available);
    const byName = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
    const configured = snapshot.config.models;
    const stale = ROLE_NAMES.filter(
      (name) =>
        name !== "orchestrator" &&
        name !== "council" &&
        configured[name] &&
        !byName.has(configured[name]),
    );
    if (!stale.length) return snapshot;
    const currentName = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    const fallback =
      (currentName && byName.has(currentName) ? currentName : undefined) ??
      ctx.scopedModels
        ?.map(({ model }) => `${model.provider}/${model.id}`)
        .find((name) => byName.has(name)) ??
      (available[0] && `${available[0].provider}/${available[0].id}`);
    if (!fallback) {
      if (canCommit())
        warn(
          ctx,
          `OMP: ${stale.join(", ")} has an unavailable model and no enabled model can replace it. Check /scoped-models or /omp.`,
        );
      return snapshot;
    }
    if (!canCommit()) return snapshot;
    const changed: string[] = [];
    snapshot.config = await updateConfig(
      (config) => {
        const models = { ...config.models };
        for (const name of stale) {
          const previous = models[name];
          if (previous && !byName.has(previous)) {
            models[name] = fallback;
            changed.push(`${name}: ${previous} → ${fallback}`);
          }
        }
        return { ...config, models };
      },
      configPath(),
      canCommit,
    );
    if (canCommit()) { footerModels = Object.values(snapshot.config.models); requestFooterRender(); }
    if (canCommit() && changed.length)
      warn(
        ctx,
        `OMP switched unavailable specialist models to enabled models: ${changed.join("; ")}`,
      );
    return snapshot;
  };

  const repaint = (job: BackgroundJob, immediate = true) => {
    if (job.session !== runtime.session) return;
    runtime.dirtyJobs.add(job);
    if (immediate) flushPaint();
  };
  const flushPaint = () => {
    for (const job of runtime.dirtyJobs) {
      for (const invalidate of job.invalidators.values()) {
        try {
          invalidate();
        } catch {
          /* A closed tool card must not affect the job. */
        }
      }
      // A released card has its final state. Do not retain callbacks into old UI trees.
      if (job.released) job.invalidators.clear();
    }
    runtime.dirtyJobs.clear();
    refreshPinned();
    requestFooterRender();
  };
  const setPinnedAvailability = (available: boolean) => {
    if (runtime.pinnedUiAvailable === available) return;
    runtime.pinnedUiAvailable = available;
    // The tool card is hidden only while the fixed widget owns it. Redraw
    // existing cards when that ownership changes in either direction.
    for (const job of runtime.pinned)
      for (const invalidate of job.invalidators.values()) {
        try {
          invalidate();
        } catch {
          /* A closed tool card cannot block jobs. */
        }
      }
  };
  const refreshPinned = () => {
    const ctx = runtime.ctx;
    if (ctx?.mode !== "tui" || typeof ctx.ui.setWidget !== "function") {
      setPinnedAvailability(false);
      return;
    }
    const pinned = [...runtime.pinned];
    const pending = [...calls.values()];
    if (!pinned.length && !pending.length) {
      runtime.scroll.listTop = 0;
      runtime.scroll.detailTop = 0;
      runtime.scroll.focusedListRow = undefined;
    }
    runtime.requestPinnedRender = undefined;
    const content: Parameters<typeof ctx.ui.setWidget>[1] =
      pinned.length || pending.length
        ? (tui, theme) => {
            runtime.requestPinnedRender = () => tui.requestRender();
            const list = new Container();
            const batches: Array<PinnedOmpBatch & { displayOrder: number }> = [
              ...pending.map((call) => ({
                kind: "call" as const,
                tasks: call.tasks,
                state: call.state,
                displayOrder: call.displayOrder,
              })),
              ...pinned.map((job) => ({
                kind: "job" as const,
                progress: job.progress,
                results: job.results,
                isPartial: job.state === "running",
                frame: () => job.animationFrame,
                state: job.pinnedState,
                displayOrder: job.displayOrder,
              })),
            ].sort((a, b) => a.displayOrder - b.displayOrder);
            const states = batches.map((batch) => batch.state);
            const toggle = (state: OmpRenderState, taskIndex: number) => {
              const wasExpanded = state.expanded?.has(taskIndex) ?? false;
              for (const other of states) {
                other.expanded?.clear();
                other.expandedOperation = undefined;
              }
              if (!wasExpanded) state.expanded = new Set([taskIndex]);
              runtime.scroll.detailTop = 0;
              refreshPinned();
            };
            const overview = new Box(1, 1, (text) =>
              paintPinnedBackground(theme,
                batches.some((batch) => batch.kind === "job")
                  ? "toolSuccessBg" : "toolPendingBg", text),
            );
            overview.addChild(renderPinnedOmpOverview(batches, theme, refreshPinned, toggle));
            list.addChild(overview);
            let detail: Box | undefined;
            let insertAfterRow: number | undefined;
            let expandedState: OmpRenderState | undefined;
            let rowOffset = 0;
            for (const batch of batches) {
              const index = batch.state.expanded?.values().next().value;
              const count = batch.kind === "call"
                ? batch.tasks.length
                : Math.max(batch.progress.length, batch.results?.length ?? 0);
              if (index !== undefined && index >= 0 && index < count) {
                const item = batch.kind === "job" ? batch.progress[index] : undefined;
                const final = batch.kind === "job" ? batch.results?.[index] : undefined;
                const task = batch.kind === "call" ? batch.tasks[index].task : item?.task ?? "";
                detail = new Box(1, 0, (text) => paintPinnedBackground(theme,
                  batch.kind === "call" ? "toolPendingBg" : "toolSuccessBg", text,
                ));
                detail.addChild(renderPinnedOmpDetail(task, item, final, theme, batch.state, refreshPinned, index));
                insertAfterRow = 3 + rowOffset + index;
                expandedState = batch.state;
                break;
              }
              rowOffset += count;
            }
            return scrollablePinnedCard(
              list,
              detail,
              insertAfterRow,
              tui.terminal?.rows ?? 24,
              runtime.scroll,
              () => tui.requestRender(),
              (text) => theme.fg("muted", text),
              (label) => {
                if (!expandedState || expandedState.inlineRange === label) return false;
                expandedState.inlineRange = label;
                list.invalidate();
                return true;
              },
            );
          }
        : undefined;
    try {
      ctx.ui.setWidget("omp-active", content, { placement: "aboveEditor" });
      setPinnedAvailability(true);
    } catch {
      setPinnedAvailability(false);
      runtime.requestPinnedRender = undefined;
    }
  };
  const pinnedJob = (callId: string) => {
    const job = runtime.jobsByCall.get(callId);
    return job && !job.released ? job : undefined;
  };
  const releaseFinished = () => {
    let released = false;
    for (const job of runtime.pinned) {
      if (job.state === "running") continue;
      job.released = true;
      runtime.pinned.delete(job);
      repaint(job, false);
      released = true;
    }
    return released;
  };
  const beginCall = (callId: string, tasks: Assignment[]) => {
    if (runtime.ctx?.mode !== "tui" || !callId || calls.has(callId) || pinnedJob(callId)) return;
    // A new dispatch closes previous finished batches in the fixed area. Their
    // original tool cards become visible in the conversation again.
    releaseFinished();
    calls.set(callId, { tasks, state: {}, displayOrder: runtime.nextDisplayOrder++ });
    flushPaint();
  };
  const renderChatCall = (
    label: string,
    tasks: Assignment[],
    theme: Parameters<typeof renderOmpToolCall>[2],
    context?: {
      state: OmpRenderState;
      invalidate: () => void;
      toolCallId: string;
      isPartial?: boolean;
      isError?: boolean;
    },
  ) => {
    if (context?.toolCallId) {
      // Persisted tool results are history, not live OMP state. Never resurrect
      // their queued/running cards when Pi rebuilds a resumed transcript.
      if (context.isPartial === false && !liveCalls.has(context.toolCallId)) {
        context.state.card?.clear();
        return new Container();
      }
      const pending = calls.get(context.toolCallId);
      // Pi renders a call before tool_execution_start. Keep that first frame
      // empty; the start event creates the fixed card from the complete task list.
      if (
        runtime.ctx?.mode === "tui" &&
        runtime.pinnedUiAvailable &&
        (context.isPartial !== false || pending || pinnedJob(context.toolCallId))
      ) {
        context.state.card?.clear();
        return new Container();
      }
      const released = runtime.jobsByCall.get(context.toolCallId);
      if (
        released?.released &&
        context.state.expanded === undefined &&
        released.pinnedState.expanded
      ) {
        context.state.expanded = new Set(released.pinnedState.expanded);
      }
    }
    const shell = new Box(
      1,
      1,
      (text) =>
        theme.bg?.(
          context?.isPartial === false
            ? context.isError
              ? "toolErrorBg"
              : "toolSuccessBg"
            : "toolPendingBg",
          text,
        ) ?? text,
    );
    shell.addChild(
      renderOmpToolCall(label, tasks, theme, context?.state ?? {}, context?.invalidate),
    );
    return shell;
  };
  const stopAnimation = () => {
    if (runtime.animationTimer) clearInterval(runtime.animationTimer);
    runtime.animationTimer = undefined;
  };
  const startAnimation = () => {
    if (runtime.animationTimer || runtime.ctx?.mode !== "tui") return;
    runtime.animationTimer = setInterval(() => {
      let running = false;
      for (const job of runtime.running) {
        if (job.controller.signal.aborted) continue;
        job.animationFrame = (job.animationFrame + 1) % OMP_SPINNER_FRAMES.length;
        running = true;
      }
      if (runtime.dirtyJobs.size) flushPaint();
      else if (running) runtime.requestPinnedRender?.();
      if (!running) stopAnimation();
    }, 80);
    runtime.animationTimer.unref?.();
  };
  const stopAnimationIfIdle = () => {
    if (!runtime.running.size) stopAnimation();
  };
  const cancelRunning = () => {
    dispatchRevision++;
    // Cancellation results remain available as context, but must not wake the
    // model after ESC (including a completed result waiting for delivery retry).
    for (const item of runtime.pending) item.wake = false;
    releaseBackgroundWaiters();
    stopAnimation();
    runtime.dirtyJobs.clear();
    for (const job of runtime.running) {
      if (job.deliveryTimer) clearTimeout(job.deliveryTimer);
      job.controller.abort();
    }
    runtime.running.clear();
  };
  const watchAbort = (previous: AbortSignal | undefined, signal: AbortSignal | undefined) => {
    if (signal === previous) return signal;
    previous?.removeEventListener("abort", cancelRunning);
    signal?.addEventListener("abort", cancelRunning, { once: true });
    if (signal?.aborted) cancelRunning();
    return signal;
  };
  const watchParent = (signal: AbortSignal | undefined) => {
    parentSignal = watchAbort(parentSignal, signal);
  };
  const clearCompactionWatch = () => {
    compactionSignal = watchAbort(compactionSignal, undefined);
  };
  const finishCompaction = () => {
    clearCompactionWatch();
    flushPending();
  };
  const prepareDispatch = (ctx: ExtensionContext, signal?: AbortSignal) => {
    if (!acceptingWork) throw new Error("OMP session is closed");
    const operationSignal = ctx.signal ?? signal;
    watchParent(operationSignal);
    const session = runtime.session;
    const revision = dispatchRevision;
    const current = () =>
      acceptingWork && session === runtime.session && revision === dispatchRevision &&
      !operationSignal?.aborted && !signal?.aborted;
    const assertCurrent = () => {
      if (!current()) throw new Error("Specialist dispatch cancelled; start a new task when ready");
    };
    assertCurrent();
    return { current, assertCurrent };
  };
  const bindContext = (ctx: ExtensionContext) => {
    runtime.pi = pi;
    runtime.ctx = ctx;
  };
  let delivering = false;
  const flushPending = () => {
    if (!runtime.pi || delivering) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
    if (!runtime.pending.length || compactionSignal) return;
    // Native recovery/summarization can be busy without an active agent signal.
    // Earlier before_compact handlers may still own the summary, and session_compact
    // itself precedes native teardown. Do not start a concurrent model in either
    // gap. An active agent can receive steering; otherwise wait locally for idle.
    // This wait is not a delivery error and makes no provider requests.
    if (!runtime.ctx?.signal && !runtime.ctx?.isIdle()) {
      runtime.retryTimer = setTimeout(flushPending, 50);
      runtime.retryTimer.unref?.();
      return;
    }
    delivering = true;
    try {
      const pending = runtime.pending.splice(0);
      for (const item of pending) {
        if (item.session !== runtime.session) continue;
        if (item.retryAt && item.retryAt > performance.now()) {
          runtime.pending.push(item);
          continue;
        }
        try {
          runtime.pi.sendMessage(
            { customType: "omp-background-result", display: false, content: item.content },
            { triggerTurn: item.wake, deliverAs: "steer" },
          );
          deliveryRevision++;
          releaseBackgroundWaiters();
        } catch {
          if (item.session !== runtime.session) continue;
          item.attempts++;
          if (item.attempts === 6) {
            try {
              runtime.ctx?.ui.notify(
                "OMP completed a background task, but could not deliver its result yet. Check the task card; delivery will keep retrying.",
                "warning",
              );
            } catch {
              /* A broken notification UI must not crash the extension timer. */
            }
          }
          const delay =
            item.attempts < 6 ? 100 : Math.min(30_000, 1000 * 2 ** Math.min(item.attempts - 6, 5));
          item.retryAt = performance.now() + delay;
          runtime.pending.push(item);
          continue;
        }
        for (const entry of item.completed ?? [])
          if (entry.result.timings) entry.result.timings.deliveryMs = performance.now() - entry.at;
      }
    } finally {
      delivering = false;
      if (runtime.pending.length) {
        const now = performance.now();
        const nextAttempt = runtime.pending.reduce(
          (earliest, item) => Math.min(earliest, item.retryAt ?? now),
          Infinity,
        );
        const delay = Math.max(0, nextAttempt - now);
        runtime.retryTimer = setTimeout(() => {
          runtime.retryTimer = undefined;
          flushPending();
        }, delay);
        runtime.retryTimer.unref?.();
      }
    }
  };
  const deliver = (
    job: BackgroundJob,
    content: string,
    completed?: Array<{ result: Result; at: number }>,
  ) => {
    if (job.session !== runtime.session) return;
    runtime.pending.push({
      session: job.session, content, attempts: 0,
      wake: !job.controller.signal.aborted, completed,
    });
    flushPending();
  };
  const visibleResult = (
    result: AgentToolResult<OmpDetails>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Parameters<typeof renderOmpToolResult>[2],
    context?: { state: OmpRenderState; invalidate: () => void; toolCallId: string },
  ) => {
    const job = result.details?.jobId ? jobs.get(result.details.jobId) : undefined;
    if (
      (result.details?.jobId && !job) ||
      (context?.toolCallId && !options.isPartial && !liveCalls.has(context.toolCallId))
    ) {
      context?.state.card?.clear();
      return new Container();
    }
    if (job && context?.toolCallId) {
      if (job.callId !== context.toolCallId && runtime.jobsByCall.get(job.callId) === job)
        runtime.jobsByCall.delete(job.callId);
      job.callId = context.toolCallId;
      runtime.jobsByCall.set(job.callId, job);
      if (!job.released) job.invalidators.set(context.toolCallId, context.invalidate ?? (() => {}));
    }
    const moved =
      runtime.ctx?.mode === "tui" &&
      runtime.pinnedUiAvailable &&
      !!context &&
      (options.isPartial ||
        !!(job && !job.released) ||
        !!(context?.toolCallId && calls.has(context.toolCallId)));
    return renderOmpToolResult(
      job
        ? {
            ...result,
            details: {
              ...result.details,
              progress: job.progress,
              results: job.results,
              animationFrame: job.animationFrame,
            },
          }
        : result,
      job ? { ...options, isPartial: job.state === "running" } : options,
      theme,
      context?.state ?? {},
      context?.invalidate,
      moved,
    );
  };

  const startJob = (
    ctx: ExtensionContext,
    prepared: ReturnType<typeof prepareAssignments>,
    kind: BackgroundJob["kind"],
    callId: string,
    launches: ReadonlyMap<Role, AgentLaunch>,
  ): AgentToolResult<OmpDetails> => {
    const childLaunches = launches;
    const id = randomUUID();
    const controller = new AbortController();
    const job: BackgroundJob = {
      id,
      callId,
      kind,
      session: runtime.session,
      state: "running",
      progress: queuedProgress(prepared.items),
      controller,
      invalidators: new Map(),
      pinnedState: calls.get(callId)?.state ?? {},
      displayOrder: calls.get(callId)?.displayOrder ?? runtime.nextDisplayOrder++,
      released: false,
      animationFrame: 0,
    };
    bindContext(ctx);
    const dcpSnapshot = discoverDcpTools(pi);
    calls.delete(callId);
    jobs.set(id, job);
    runtime.jobsByCall.set(callId, job);
    runtime.running.add(job);
    runtime.pinned.add(job);
    refreshPinned();
    startAnimation();
    const completed = new Set<number>();
    const pendingResults: Array<{ result: Result; at: number }> = [];
    const flushResults = () => {
      if (job.deliveryTimer) clearTimeout(job.deliveryTimer);
      job.deliveryTimer = undefined;
      if (!pendingResults.length || job.session !== runtime.session) return;
      const ready = pendingResults.splice(0);
      const remaining = prepared.items.length - completed.size;
      const outstanding = [...runtime.running].reduce(
        (count, batch) =>
          count +
          batch.progress.filter((row) => row.state === "queued" || row.state === "running").length,
        0,
      );
      deliver(
        job,
        `OMP background delegate ${remaining ? "progress" : controller.signal.aborted ? "cancelled" : "finished"}. ${completed.size}/${prepared.items.length} tasks completed; ${outstanding} OMP tasks still running. Integrate these terminal results and advance only dependencies they satisfy. Reuse still-valid verification evidence. Do not finalize while required tasks remain.\n\n${formatResults(ready.map((item) => item.result))}`,
        ready,
      );
    };
    void runAssignments(
      ctx,
      prepared.items,
      controller.signal,
      (progress) => {
        if (job.session !== runtime.session) return;
        for (const row of progress) recordUsage(row.runId, row.usage, row.taskId, row.model);
        job.progress = progress;
        repaint(job, runtime.ctx?.mode !== "tui");
      },
      childLaunches,
      sessions,
      (result, index) => {
        if (completed.has(index) || job.session !== runtime.session) return;
        completed.add(index);
        recordUsage(result.runId, result.usage, result.taskId, result.model);
        if (kind === "council") return;
        pendingResults.push({ result, at: performance.now() });
        if (completed.size === prepared.items.length) flushResults();
        else job.deliveryTimer ??= setTimeout(flushResults, 50);
      },
      dcpSnapshot,
    )
      .then((results) => {
        if (job.session !== runtime.session) return;
        job.results = results;
        job.state = controller.signal.aborted
          ? "cancelled"
          : results.some((result) => !result.ok)
            ? "failed"
            : "done";
        runtime.running.delete(job);
        stopAnimationIfIdle();
        repaint(job);
        if (kind !== "council") {
          flushResults();
          return;
        }
        const summary = formatResults(results);
        const councilHeader =
          job.state === "cancelled"
            ? "Some specialist tasks were cancelled. Review any completed results.\n\n"
            : kind === "council"
              ? `${results.filter((result) => result.ok).length}/${results.length} reviewers responded. These perspectives use the same inherited model, so do not claim cross-model agreement. Synthesize disagreements. Disclose missing, failed, blocked or shortened reviews; never infer consensus from them.\n\n`
              : "Verify and integrate these specialist results before finalizing.\n\n";
        deliver(job, `OMP background ${kind} ${job.state}. ${councilHeader}${summary}`);
      })
      .catch((err) => {
        if (job.session !== runtime.session) return;
        flushResults();
        job.state = controller.signal.aborted ? "cancelled" : "failed";
        runtime.running.delete(job);
        stopAnimationIfIdle();
        repaint(job);
        const detail = failureDetail(err);
        deliver(
          job,
          `OMP background ${kind} ${job.state}. Inspect partial work before retrying.${detail ? ` Cause: ${detail}` : ""}`,
        );
      });
    flushPaint();
    return {
      content: [
        {
          type: "text",
          text: `OMP background ${kind} started. ${job.progress.map((row) => `${row.agent}: taskId=${row.taskId ?? "pending"}`).join("; ")}. Continue independent work. If nothing independent remains, end this turn with a brief status; completion will wake you. Never use shell sleep or polling to wait.`,
        },
      ],
      details: { jobId: id, progress: job.progress, animationFrame: job.animationFrame },
    };
  };

  function status(ctx?: ExtensionContext) {
    try {
      ctx?.ui.setStatus(
        OMP_STATUS_KEY,
        `OMP:${role}${mainTokenRate !== undefined ? ` · ${formatTokenRate(mainTokenRate)}` : ""}`,
      );
    } catch {
      /* A stale UI must not interrupt session or worker lifecycle events. */
    }
  }

  const resetMainThroughput = () => {
    mainMessageStartedAt = undefined;
    mainOutputTokens = 0;
    mainGenerationMs = 0;
    mainTokenRate = undefined;
    lastRateStatusAt = 0;
    mainStreamingUsage = emptyUsage();
  };
  const updateMainThroughput = (
    ctx: ExtensionContext,
    partialOutput = 0,
    partialMs = 0,
    force = false,
  ) => {
    const output = mainOutputTokens + partialOutput;
    const duration = mainGenerationMs + partialMs;
    if (!(output > 0 && duration > 0)) return;
    mainTokenRate = (output * 1000) / duration;
    const now = performance.now();
    if (force || lastRateStatusAt === 0 || now - lastRateStatusAt >= 250) {
      lastRateStatusAt = now;
      status(ctx);
    }
  };

  async function applySetting(
    id: string,
    value: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (id === "default" && isMainAgent(value)) {
      await updateConfig((current) => ({ ...current, defaultAgent: value }));
      role = value;
      if (role === "pi") cancelRunning();
      reconcileTools(role);
      status(ctx);
      return;
    }
    if (
      id.startsWith("role:") &&
      isRole(id.slice(5)) &&
      !["orchestrator", "council"].includes(id.slice(5))
    ) {
      const name = id.slice(5) as Role;
      const selected = parseRoleSettingValue(value);
      if (!selected) throw new Error(`Invalid specialist model/thinking selection: ${value}`);
      const thinkingLevel =
        selected.thinking === INHERIT_THINKING
          ? undefined
          : isThinkingLevel(selected.thinking)
            ? selected.thinking
            : null;
      if (thinkingLevel === null)
        throw new Error(`Invalid specialist model/thinking selection: ${value}`);
      const model = selected.model === INHERIT ? undefined : selected.model;
      if (model) {
        const spec = parseModel(model);
        if (
          !spec ||
          !availableChildModels(ctx).some((m) => m.provider === spec.provider && m.id === spec.id)
        ) {
          throw new Error(
            `Model ${model} is not enabled or available; check /scoped-models and provider authentication`,
          );
        }
      }
      const config = await updateConfig((current) => {
        const models = { ...current.models };
        if (model) models[name] = model;
        else delete models[name];
        const thinking = { ...current.thinking };
        if (thinkingLevel === undefined) delete thinking[name];
        else thinking[name] = thinkingLevel;
        return { ...current, models, thinking };
      });
      footerModels = Object.values(config.models);
      requestFooterRender();
      return;
    }
    throw new Error(`Invalid setting ${id}: ${value}`);
  }

  pi.registerCommand("omp", {
    description: "Open main agent and specialist model/thinking settings",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Enter /omp without arguments to open settings", "warning");
        return;
      }
      try {
        await reconcileModels(ctx);
        await showSettingsUi(ctx, { apply: applySetting });
      } catch (err) {
        ctx.ui.notify(
          `OMP configuration failed (${configPath()}): ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "omp_delegate" && event.toolName !== "omp_council") return;
    if (!acceptingWork) return;
    liveCalls.add(event.toolCallId);
    bindContext(ctx);
    if (event.toolName === "omp_delegate") {
      const args = event.args ?? {};
      const tasks = Array.isArray(args.tasks)
        ? args.tasks.map((item: any) => ({
            agent: typeof item?.agent === "string" ? item.agent : "explorer",
            task: typeof item?.task === "string" ? item.task : "",
          }))
        : [
            {
              agent: typeof args.agent === "string" ? args.agent : "explorer",
              task: typeof args.task === "string" ? args.task : "",
            },
          ];
      beginCall(event.toolCallId, tasks as Assignment[]);
    } else if (event.toolName === "omp_council") {
      beginCall(event.toolCallId, councilAssignments(String(event.args?.question ?? "")));
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (!calls.has(event.toolCallId)) return;
    calls.delete(event.toolCallId);
    refreshPinned();
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    inputRevision++;
    releaseBackgroundWaiters();
    if (releaseFinished()) flushPaint();
  });

  pi.on("context", () => {
    observedDeliveryRevision = deliveryRevision;
    observedInputRevision = inputRevision;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!acceptingWork) return;
    watchParent(ctx.signal);
    flushPending();
  });

  // Pi's ESC during compaction aborts a separate controller, not ctx.signal.
  // Observe that operation, never raw keys: ESC in a picker remains a UI action.
  pi.on("session_before_compact", (event) => {
    if (!acceptingWork) return;
    compactionSignal = watchAbort(compactionSignal, event.signal);
    flushPending(); // pause any pending retry timer until the terminal hook
  });
  pi.on("session_compact", finishCompaction);
  // aborted can also mean an extension veto; only the signal proves an abort.
  pi.on("session_compact_failed", finishCompaction);

  pi.on("agent_end", async (event, ctx) => {
    const lastAssistant = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      role === "pi" ||
      (!runtime.running.size && !runtime.pending.length) ||
      deliveryRevision !== observedDeliveryRevision ||
      inputRevision !== observedInputRevision ||
      ctx.signal?.aborted ||
      lastAssistant?.stopReason === "error" ||
      lastAssistant?.stopReason === "aborted"
    )
      return;

    // Pi awaits this boundary before draining follow-ups (including goal
    // continuations). Hold it locally until there is new information to consume.
    const signal = ctx.signal;
    await new Promise<void>((resolve) => {
      const finish = () => {
        backgroundWaiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      backgroundWaiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  });

  const clearRuntime = () => {
    acceptingWork = false;
    runtime.session++;
    watchParent(undefined);
    clearCompactionWatch();
    resetMainThroughput();
    cancelRunning();
    const oldCtx = runtime.ctx;
    runtime.pi = undefined;
    runtime.ctx = undefined;
    runtime.requestPinnedRender = undefined;
    requestFooterRender = () => {};
    runtime.pinnedUiAvailable = false;
    for (const job of jobs.values()) job.invalidators.clear();
    jobs.clear();
    runtime.jobsByCall.clear();
    runtime.pinned.clear();
    calls.clear();
    liveCalls.clear();
    runtime.pending.length = 0;
    runtime.scroll = { listTop: 0, detailTop: 0 };
    runtime.nextDisplayOrder = 0;
    observedDeliveryRevision = deliveryRevision;
    observedInputRevision = inputRevision;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
    try { oldCtx?.ui.setWidget?.("omp-active", undefined); } catch { /* Stale UI. */ }
    try { oldCtx?.ui.setStatus(OMP_STATUS_KEY, undefined); } catch { /* Stale UI. */ }
    return sessions.clear({ discard: true });
  };

  pi.on("session_start", async (_event, ctx) => {
    const clearing = clearRuntime();
    const session = runtime.session;
    await clearing;
    if (session !== runtime.session) return;
    acceptingWork = true;
    bindContext(ctx);
    restoreUsageFooter(ctx);
    refreshPinned();
    try {
      const config = readConfig();
      role = config.defaultAgent;
      footerModels = Object.values(config.models);
    } catch (err) {
      role = "orchestrator";
      footerModels = [];
      warn(
        ctx,
        `OMP: failed to read ${configPath()}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    reconcileTools(role);
    status(ctx);
    try {
      await reconcileModels(ctx, () => session === runtime.session);
    } catch (err) {
      if (session === runtime.session)
        warn(
          ctx,
          `OMP: could not update specialist models: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
  });

  pi.on("session_shutdown", clearRuntime);

  pi.on("session_tree", async (_event, ctx) => {
    const clearing = clearRuntime();
    const session = runtime.session;
    await clearing;
    if (session !== runtime.session) return;
    acceptingWork = true;
    bindContext(ctx);
    restoreUsageFooter(ctx);
    refreshPinned();
    status(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    resetMainThroughput();
    status(ctx);
    reconcileTools(role);
    if (role === "pi") {
      delete event.systemPromptOptions.sections.omp_role;
      delete event.systemPromptOptions.sections.omp_roster;
      return;
    }
    event.systemPromptOptions.sections.omp_role = `Active OMP main agent: ${role}. ${ROLES[role].prompt}${role === "orchestrator" ? " Prefer Pi's native MCP tools, including calls through codemode or tools loaded with tool_search. Use only permitted non-context7 server namespaces. Resource requests must name one permitted server explicitly. With a legacy adapter, use only server-scoped gateway calls such as mcp({server:'gh_grep',tool:'search',args:{query:'example'}}). Never use unscoped gateway calls, gateway search/describe/instructions modes, mcpScript, or the context7 server (including its namespace). Unattributed adapter direct tools are unavailable." : ""}`;
    event.systemPromptOptions.sections.omp_roster = `Specialists available with omp_delegate: ${ROLE_NAMES.filter(
      (name) => name !== "orchestrator" && name !== "council",
    )
      .map((name) => `${name} (${ROLES[name].description})`)
      .join(
        "; ",
      )}. OMP tasks and task IDs exist only in the current runtime. Exit, reload, session replacement and tree navigation clear them; never wait for or resume old tasks from restored history. Inspect partial work before assigning a new task. Before dispatching, check current-runtime tasks and their results for the same objective. If the user adds requirements to a running task, retain the amendment in the parent conversation and wait for that task's terminal result, then continue it by the same taskId. Do not cancel it or create a duplicate merely for an additive request, and do not claim the child received the amendment before it is actually dispatched. A refused taskId sends no new prompt; do not omit that ID to replay the same live objective as a new task. Cancellation does not undo edits or satisfy required verification. All delegation and Council work runs in the background. Continue only independent work; if none remains, end your turn with a brief status, without claiming the task is finished. OMP waits locally at the turn boundary for the next result, preventing automatic goal continuations from issuing empty model requests. Completion steers an active turn at the next safe tool boundary. Never use shell sleep or polling to wait for specialists. Use their findings only after the completion message arrives. Progress and assistant replies remain in the fixed OMP task card until the next user input. Give one writer ownership of each file. For high-stakes choices use omp_council. Specialist results are evidence to verify, not a substitute for your own responsibility. An OK result confirms normal runtime completion, not acceptance: review refusals, blockers, missing checks and report omissions before advancing dependencies. Failed or cancelled runs are not proof of completion.`;
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      mainMessageStartedAt = performance.now();
      mainStreamingUsage = emptyUsage();
    }
  });

  pi.on("message_update", (event, ctx) => {
    const partial =
      "partial" in event.assistantMessageEvent ? event.assistantMessageEvent.partial : undefined;
    const output = partial?.usage?.output;
    if (partial?.usage) mainStreamingUsage = addUsage(emptyUsage(), partial.usage);
    if (
      mainMessageStartedAt !== undefined &&
      typeof output === "number" &&
      Number.isFinite(output) &&
      output > 0
    ) {
      updateMainThroughput(ctx, output, Math.max(1, performance.now() - mainMessageStartedAt));
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    mainStreamingUsage = emptyUsage();
    const output = event.message.usage?.output;
    if (
      mainMessageStartedAt !== undefined &&
      typeof output === "number" &&
      Number.isFinite(output) &&
      output > 0
    ) {
      mainOutputTokens += output;
      mainGenerationMs += Math.max(1, performance.now() - mainMessageStartedAt);
      updateMainThroughput(ctx, 0, 0, true);
    }
    mainMessageStartedAt = undefined;
  });

  pi.registerTool({
    name: "omp_delegate",
    exposure: "model-only",
    label: "OMP delegate",
    renderShell: "self",
    description:
      "Start background specialist work and receive an automatic completion message. Any number of independent tasks run concurrently. Specialists: explorer, librarian, oracle, designer, fixer. Do not send secret credentials in tasks.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Specialist for a single task" })),
      task: Type.Optional(
        Type.String({
          description: "Bounded task written in the language of the latest user message",
        }),
      ),
      taskId: Type.Optional(
        Type.String({
          description:
            "Continue a finished task in this live runtime; inspect partial work after failure/cancellation. Omit for a new objective. Never use for a running task, status check, or task from restored history.",
        }),
      ),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String(),
            task: Type.String({
              description: "Task written in the language of the latest user message",
            }),
            taskId: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
    renderCall(args, theme, context) {
      const tasks = args.tasks ?? [{ agent: args.agent ?? "explorer", task: args.task ?? "" }];
      return renderChatCall("OMP delegate", tasks as Assignment[], theme, context);
    },
    renderResult(result, options, theme, context) {
      return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context);
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const dispatch = prepareDispatch(ctx, signal);
      liveCalls.add(_id);
      bindContext(ctx);
      if (role === "pi")
        throw new Error("OMP delegation is disabled while the default agent is pi");
      const single =
        params.agent !== undefined || params.task !== undefined || params.taskId !== undefined;
      const list = params.tasks !== undefined;
      if (single === list || (list && !params.tasks?.length))
        throw new Error("Provide either one agent + task or a non-empty tasks array");
      const items = list
        ? params.tasks!
        : [{ agent: params.agent!, task: params.task!, taskId: params.taskId }];
      if (
        items.some(
          (item) =>
            !isRole(item.agent) ||
            ["orchestrator", "council"].includes(item.agent) ||
            !item.task?.trim() ||
            item.task.length > 12_000,
        )
      ) {
        throw new Error(
          "Only explorer/librarian/oracle/designer/fixer are supported; task must be 1-12000 characters",
        );
      }
      const assignments = items as Assignment[];
      sessions.validate(assignments, taskScope(ctx));
      beginCall(_id, assignments);
      const snapshot = await reconcileModels(ctx, dispatch.current);
      dispatch.assertCurrent();
      // Validate the entire batch once before starting any children.
      const launches = resolveLaunches(ctx, assignments, snapshot);
      onUpdate?.({
        content: [{ type: "text", text: "OMP: starting specialists" }],
        details: { progress: queuedProgress(assignments) },
      });
      dispatch.assertCurrent();
      const prepared = prepareAssignments(ctx, assignments, signal);
      sessions.validate(prepared.items, taskScope(ctx));
      return startJob(ctx, prepared, "delegate", _id, launches);
    },
  });

  pi.registerTool({
    name: "omp_council",
    exposure: "model-only",
    label: "OMP council",
    renderShell: "self",
    description:
      "Consult three independent review sessions (failure modes, architecture, minimal alternative). Costs three model runs; synthesize the actual opinions and disclose disagreements. All reviewers inherit the current main session's model and thinking level.",
    parameters: Type.Object({
      question: Type.String({
        description:
          "A consequential technical decision to review, written in the language of the latest user message",
      }),
    }),
    renderCall(args, theme, context) {
      return renderChatCall("OMP council", councilAssignments(args.question), theme, context);
    },
    renderResult(result, options, theme, context) {
      return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context);
    },
    async execute(_id, { question }, signal, onUpdate, ctx) {
      const dispatch = prepareDispatch(ctx, signal);
      liveCalls.add(_id);
      bindContext(ctx);
      if (role === "pi")
        throw new Error("OMP delegation is disabled while the default agent is pi");
      if (!question.trim() || question.length > 12_000)
        throw new Error("question must be 1-12000 characters");
      const assignments = councilAssignments(question);
      const launches = resolveLaunches(ctx, assignments, {
        config: readConfig(),
        available: ctx.modelRegistry.getAvailable(),
      });
      beginCall(_id, assignments);
      onUpdate?.({
        content: [{ type: "text", text: "Council: starting specialists" }],
        details: { progress: queuedProgress(assignments) },
      });
      dispatch.assertCurrent();
      const prepared = prepareAssignments(ctx, assignments, signal);
      return startJob(ctx, prepared, "council", _id, launches);
    },
  });
}
