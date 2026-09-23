import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configPath, isThinkingLevel, parseModel, readConfig, updateConfig } from "./config.ts";
import { ROLES, ROLE_NAMES, isMainAgent, isRole, type MainAgent, type Role } from "./roles.ts";
import { showSettingsUi, INHERIT, INHERIT_THINKING, parseRoleSettingValue } from "./settings-ui.ts";
import { formatResults, queuedProgress, resolveModel, runAssignments, type AgentProgress, type Assignment, type OmpDetails, type Result } from "./subagents.ts";
import { renderOmpToolCall, renderOmpToolResult, type OmpRenderState } from "./render.ts";
import { prepareAssignments } from "./language.ts";
import { installMcpPolicy } from "./mcp-policy.ts";
import { availableChildModels } from "./models.ts";

const COUNCIL_PERSPECTIVES = [
  "Find failure modes, safety issues, and counterexamples.",
  "Assess architecture, feasibility, and maintenance trade-offs.",
  "Find the simplest acceptable option and evaluate opportunity cost.",
];
const councilAssignments = (question: string): Assignment[] =>
  COUNCIL_PERSPECTIVES.map((perspective) => ({ agent: "council", task: `${perspective}\n\nDecision: ${question}` }));

type BackgroundJob = {
  id: string;
  kind: "delegate" | "council";
  session: number;
  state: "running" | "done" | "failed" | "cancelled";
  progress: AgentProgress[];
  results?: Result[];
  controller: AbortController;
  invalidators: Map<string, () => void>;
};

export default function omp(pi: ExtensionAPI) {
  // Child sessions need personal provider extensions but must not register OMP again.
  if (process.env.PI_OMP_CHILD === "1") return;
  let role: MainAgent = "orchestrator";
  let session = 0;
  const jobs = new Map<string, BackgroundJob>();
  const reconcileTools = installMcpPolicy(pi, () => role);

  const repaint = (job: BackgroundJob) => {
    for (const invalidate of job.invalidators.values()) {
      try { invalidate(); } catch { /* A closed tool card must not affect the job. */ }
    }
  };
  const cancelRunning = () => {
    for (const job of jobs.values()) if (job.state === "running") job.controller.abort();
  };
  const visibleResult = (result: AgentToolResult<OmpDetails>, options: { expanded: boolean; isPartial: boolean }, theme: Parameters<typeof renderOmpToolResult>[2], context?: { state: OmpRenderState; invalidate: () => void; toolCallId: string }) => {
    const job = result.details?.jobId ? jobs.get(result.details.jobId) : undefined;
    if (job && context?.toolCallId) job.invalidators.set(context.toolCallId, context.invalidate ?? (() => {}));
    return renderOmpToolResult(
      job ? { ...result, details: { ...result.details, progress: job.progress, results: job.results } } : result,
      job ? { ...options, isPartial: job.state === "running" } : options,
      theme, context?.state ?? {}, context?.invalidate,
    );
  };

  const startJob = (
    ctx: ExtensionContext,
    prepared: Awaited<ReturnType<typeof prepareAssignments>>,
    kind: BackgroundJob["kind"],
    modelOverride?: string,
  ): AgentToolResult<OmpDetails> => {
    const id = randomUUID();
    const controller = new AbortController();
    const job: BackgroundJob = {
      id, kind, session, state: "running", progress: queuedProgress(prepared.items),
      controller, invalidators: new Map(),
    };
    jobs.set(id, job);
    // Keep a bounded in-memory task board; running work is never evicted.
    for (const [oldId, old] of jobs) {
      if (jobs.size <= 24) break;
      if (old.state !== "running") jobs.delete(oldId);
    }
    const deliver = (content: string) => {
      if (job.session !== session) return;
      try {
        pi.sendMessage({ customType: "omp-background-result", display: false, content },
          { triggerTurn: true, deliverAs: "followUp" });
      } catch { /* The result remains available through omp_task if the host cannot deliver. */ }
    };
    void runAssignments(ctx, prepared.items, controller.signal, (progress) => {
      job.progress = progress;
      repaint(job);
    }, modelOverride, id).then((results) => {
      job.results = results;
      job.state = controller.signal.aborted ? "cancelled" : results.some((result) => !result.ok) ? "failed" : "done";
      repaint(job);
      const summary = formatResults(results);
      const councilHeader = kind === "council"
        ? `${results.filter((result) => result.ok).length}/${results.length} reviewers responded. These perspectives use the same inherited model, so do not claim cross-model agreement. Synthesize disagreements.\n\n`
        : "Verify and integrate these specialist results before finalizing.\n\n";
      deliver(`OMP background ${kind} task ${id} ${job.state}. ${councilHeader}${summary.slice(0, 30_000)}${summary.length > 30_000 ? `\n[Result truncated; call omp_task with action=result and id=${id}]` : ""}`);
    }).catch(() => {
      job.state = controller.signal.aborted ? "cancelled" : "failed";
      repaint(job);
      deliver(`OMP background ${kind} task ${id} ${job.state}. Inspect partial work before retrying.`);
    });
    return {
      content: [{ type: "text", text: `OMP background ${kind} task ${id} started. Continue independent work; completion will arrive automatically. Use omp_task to check status or retrieve results.` }],
      details: { jobId: id, progress: job.progress }, usage: prepared.usage,
    };
  };

  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus("omp", `OMP:${role}`);
  }

  async function applySetting(id: string, value: string, ctx: ExtensionCommandContext): Promise<void> {
    if (id === "default" && isMainAgent(value)) {
      await updateConfig((current) => ({ ...current, defaultAgent: value }));
      role = value;
      if (role === "pi") cancelRunning();
      reconcileTools(role);
      status(ctx);
      return;
    }
    if (id.startsWith("role:") && isRole(id.slice(5)) && !["orchestrator", "council"].includes(id.slice(5))) {
      const name = id.slice(5) as Role;
      const selected = parseRoleSettingValue(value);
      if (!selected) throw new Error(`Invalid specialist model/thinking selection: ${value}`);
      const thinkingLevel = selected.thinking === INHERIT_THINKING ? undefined
        : isThinkingLevel(selected.thinking) ? selected.thinking : null;
      if (thinkingLevel === null) throw new Error(`Invalid specialist model/thinking selection: ${value}`);
      const model = selected.model === INHERIT ? undefined : selected.model;
      if (model) {
        const spec = parseModel(model);
        if (!spec || !availableChildModels(ctx).some((m) => m.provider === spec.provider && m.id === spec.id)) {
          throw new Error(`Model ${model} is not enabled or available; check /scoped-models and provider authentication`);
        }
      }
      await updateConfig((current) => {
        const models = { ...current.models };
        if (model) models[name] = model;
        else delete models[name];
        const thinking = { ...current.thinking };
        if (thinkingLevel === undefined) delete thinking[name];
        else thinking[name] = thinkingLevel;
        return { ...current, models, thinking };
      });
      return;
    }
    throw new Error(`Invalid setting ${id}: ${value}`);
  }

  pi.registerCommand("omp", {
    description: "Open default main agent, specialist model, and thinking settings",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Enter /omp without arguments to open settings", "warning");
        return;
      }
      try {
        await showSettingsUi(ctx, { apply: applySetting });
      } catch (err) {
        ctx.ui.notify(`OMP configuration failed (${configPath()}): ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    cancelRunning();
    jobs.clear();
    session++;
    try {
      role = readConfig().defaultAgent;
    } catch (err) {
      role = "orchestrator";
      ctx.ui.notify(`OMP: failed to read ${configPath()}: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
    reconcileTools(role);
    status(ctx);
  });

  pi.on("session_shutdown", () => {
    session++;
    cancelRunning();
    jobs.clear();
  });

  pi.on("before_agent_start", (event) => {
    reconcileTools(role);
    if (role === "pi") {
      delete event.systemPromptOptions.sections.omp_role;
      delete event.systemPromptOptions.sections.omp_roster;
      return;
    }
    event.systemPromptOptions.sections.omp_role = `Active OMP main agent: ${role}. ${ROLES[role].prompt}${role === "orchestrator" ? " For MCP access use only server-scoped gateway calls such as mcp({server:'gh_grep',tool:'search',args:{query:'example'}}). Never use unscoped gateway calls, gateway search/describe/instructions modes, mcpScript, or the context7 server (including its namespace). Direct MCP tools are unavailable; adapter tool descriptions may suggest calls that OMP blocks." : ""}`;
    event.systemPromptOptions.sections.omp_roster = `Specialists available with omp_delegate: ${ROLE_NAMES.filter((name) => name !== "orchestrator" && name !== "council").map((name) => `${name} (${ROLES[name].description})`).join("; ")}. All delegation and Council work runs in the background: track each task ID, continue only independent work, and wait for the automatic completion message before using its findings. Use omp_task to check, retrieve or cancel a job. Give one writer ownership of each file. For high-stakes choices use omp_council. Specialist results are evidence to verify, not a substitute for your own responsibility.`;
  });

  pi.registerTool({
    name: "omp_delegate", label: "OMP delegate",
    description: "Start background specialist work and receive an automatic completion message. One to four independent tasks, at most three children running across all batches. Specialists: explorer, librarian, oracle, designer, fixer. Do not send secret credentials in tasks.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Specialist for a single task" })),
      task: Type.Optional(Type.String({ description: "Bounded task for the specialist" })),
      tasks: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), { maxItems: 4 })),
    }),
    renderCall(args, theme, context) {
      const tasks = args.tasks ?? [{ agent: args.agent ?? "explorer", task: args.task ?? "" }];
      return renderOmpToolCall("OMP delegate", tasks as Assignment[], theme, context?.state ?? {}, context?.invalidate);
    },
    renderResult(result, options, theme, context) { return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context); },
    async execute(_id, params, signal, onUpdate, ctx) {
      if (role === "pi") throw new Error("OMP delegation is disabled while the default agent is pi");
      const single = params.agent !== undefined || params.task !== undefined;
      const list = params.tasks !== undefined;
      if (single === list || (list && (!params.tasks?.length || params.tasks.length > 4))) throw new Error("Provide either one agent + task or 1-4 tasks");
      const items = (list ? params.tasks! : [{ agent: params.agent!, task: params.task! }]);
      if (items.some((item) => !isRole(item.agent) || ["orchestrator", "council"].includes(item.agent) || !item.task?.trim() || item.task.length > 12_000)) {
        throw new Error("Only explorer/librarian/oracle/designer/fixer are supported; task must be 1-12000 characters");
      }
      const assignments = items as Assignment[];
      onUpdate?.({ content: [{ type: "text", text: "OMP: preparing user-language prompts" }], details: { progress: queuedProgress(assignments) } });
      const prepared = await prepareAssignments(ctx, assignments, signal);
      return startJob(ctx, prepared, "delegate");
    },
  });

  pi.registerTool({
    name: "omp_task", label: "OMP task",
    description: "Check background OMP jobs, retrieve a completed result, or cancel a running job. Never treat a running task as finished.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("result"), Type.Literal("cancel")]),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id, { action, id }) {
      if (role === "pi") throw new Error("OMP delegation is disabled while the default agent is pi");
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
      if (action === "status" && !id) {
        const text = [...jobs.values()].map((job) => `${job.id} · ${job.state} · ${job.progress.filter((item) => item.state === "done" || item.state === "failed").length}/${job.progress.length}`).join("\n");
        return reply(text || "No OMP background tasks in this session.");
      }
      if (!id || !jobs.has(id)) throw new Error("Unknown OMP task ID in this session");
      const job = jobs.get(id)!;
      if (action === "cancel") {
        if (job.state === "running") job.controller.abort();
        return reply(`${id} · ${job.state === "running" ? "cancellation requested" : job.state}`);
      }
      if (action === "result") return reply(job.results ? formatResults(job.results) : `${id} · ${job.state}`);
      return reply(`${id} · ${job.state}\n${job.progress.map((item) => `${item.agent} · ${item.state}`).join("\n")}`);
    },
  });

  pi.registerTool({
    name: "omp_council", label: "OMP council",
    description: "Consult three independent review sessions (failure modes, architecture, minimal alternative). Costs three model runs; synthesize the actual opinions and disclose disagreements. All reviewers inherit the current main session's model and thinking level.",
    parameters: Type.Object({ question: Type.String({ description: "A consequential technical decision to review" }) }),
    renderCall(args, theme, context) {
      return renderOmpToolCall("OMP council", councilAssignments(args.question), theme, context?.state ?? {}, context?.invalidate);
    },
    renderResult(result, options, theme, context) { return visibleResult(result as AgentToolResult<OmpDetails>, options, theme, context); },
    async execute(_id, { question }, signal, onUpdate, ctx) {
      if (role === "pi") throw new Error("OMP delegation is disabled while the default agent is pi");
      if (!question.trim() || question.length > 12_000) throw new Error("question must be 1-12000 characters");
      const model = resolveModel(ctx, "council");
      const assignments = councilAssignments(question);
      onUpdate?.({ content: [{ type: "text", text: "Council: preparing user-language prompts" }], details: { progress: queuedProgress(assignments) } });
      const prepared = await prepareAssignments(ctx, assignments, signal);
      return startJob(ctx, prepared, "council", model);
    },
  });
}
