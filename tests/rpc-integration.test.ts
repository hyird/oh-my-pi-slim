import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, type AgentProgress } from "../extensions/omp/subagents.ts";
import { TaskSessions } from "../extensions/omp/task-sessions.ts";
import omp from "../extensions/omp/index.ts";
import { updateConfig } from "../extensions/omp/config.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

const savedOffline = process.env.PI_OFFLINE;
beforeEach(() => { process.env.PI_OFFLINE = "1"; });
afterEach(() => {
  if (savedOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedOffline;
});

test.each([
  { goalFirst: true, abort: false, retry: false },
  { goalFirst: false, abort: false, retry: false },
  { goalFirst: true, abort: true, retry: false },
  { goalFirst: false, abort: true, retry: false },
  { goalFirst: true, abort: false, retry: true },
  { goalFirst: false, abort: false, retry: true },
  { goalFirst: true, abort: false, retry: true, exhausted: true },
])(
  "native goal follow-ups wait for OMP results (goal first: $goalFirst, abort: $abort, retry: $retry, exhausted: $exhausted)",
  async ({ goalFirst, abort, retry, exhausted }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-goal-boundary-"));
    const savedDir = process.env.PI_CODING_AGENT_DIR;
    const argv = process.argv[1];
    const requests: any[] = [];
    const errors: unknown[] = [];
    let outageCleared = false;
    let session: AgentSession | undefined;
    let reachedBoundary!: () => void;
    const boundary = new Promise<void>((resolve) => {
      reachedBoundary = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(await request.json());
        if (retry && requests.length > 1 && (requests.length === 2 || (exhausted && !outageCleared)))
          return new Response(JSON.stringify({ error: { message: "Temporary local outage", type: "server_error" } }),
            { status: 503, headers: { "Content-Type": "application/json" } });
        const delegate = requests.length === 1;
        const delta = delegate
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "delegate",
                  type: "function",
                  function: {
                    name: "omp_delegate",
                    arguments: JSON.stringify({
                      agent: "explorer",
                      task: `[delay=${retry ? 200 : 800}] investigate`,
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "waiting or integrating" };
        const chunks = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: delegate ? "tool_calls" : "stop" }] },
        ];
        return new Response(
          chunks
            .map(
              (chunk) =>
                `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "mock", ...chunk })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      process.env.PI_CODING_AGENT_DIR = root;
      process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
      fs.writeFileSync(
        path.join(root, "models.json"),
        JSON.stringify({
          providers: {
            "omp-test": {
              baseUrl: `${server.url.origin}/v1`,
              api: "openai-completions",
              apiKey: "local-test-only",
              models: [
                {
                  id: "mock",
                  name: "Local mock",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 128,
                },
              ],
            },
          },
        }),
      );
      const settingsManager = SettingsManager.inMemory({
        defaultProvider: "omp-test",
        defaultModel: "mock",
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 },
      });
      // Reproduce the goal plugin's end-of-turn follow-up without depending on it.
      let continuations = 0;
      const goal: ExtensionFactory = (pi) => {
        pi.on("agent_end", (_event, ctx) => {
          // The exhaustion case isolates native retry from goal-driven recovery.
          if (ctx.signal?.aborted || exhausted) return;
          if (continuations++ === 0)
            pi.sendMessage(
              { customType: "test-goal", content: "Continue the active goal", display: false },
              { triggerTurn: true, deliverAs: "followUp" },
            );
        });
      };
      const boundaryObserver: ExtensionFactory = (pi) => {
        pi.on("agent_end", () => {
          reachedBoundary();
        });
      };
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [boundaryObserver, ...(goalFirst ? [goal, omp] : [omp, goal])],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(root),
        noTools: "builtin",
        thinkingLevel: "off",
      }));
      await session.bindExtensions({
        onError: (error) => {
          errors.push(error);
        },
      });
      const running = session.prompt("Investigate in the background and integrate the result.");
      await boundary;
      expect(requests).toHaveLength(2);
      await Bun.sleep(100);
      expect(requests).toHaveLength(2);
      if (abort) {
        // Pi's interactive ESC handler calls this same native abort operation.
        await session.abort();
        await running;
        const logs = path.join(root, "omp/conversations");
        const cancelled = () => fs.readdirSync(logs).some((file) =>
          fs.readFileSync(path.join(logs, file), "utf8").includes('"state":"cancelled"'));
        for (let i = 0; i < 100 && !cancelled(); i++) await Bun.sleep(10);
        expect(cancelled()).toBe(true);
        await Bun.sleep(100);
        expect(requests).toHaveLength(2); // cancellation must not wake a new model turn
      } else {
        if (retry) {
          const logs = path.join(root, "omp/conversations");
          const finished = () => fs.readdirSync(logs).some((file) =>
            fs.readFileSync(path.join(logs, file), "utf8").includes('"state":"done"'));
          for (let i = 0; i < 100 && !finished(); i++) await Bun.sleep(10);
          expect(finished()).toBe(true);
          expect(session.isStreaming).toBe(true);
          expect(requests).toHaveLength(2); // completed children do not interrupt native retry delay
        }
        await running;
        if (exhausted) {
          expect(session.isStreaming).toBe(false);
          expect([...session.messages].reverse().find((message) => message.role === "assistant"))
            .toMatchObject({ stopReason: "error" });
          await Bun.sleep(100);
          expect(requests).toHaveLength(3); // one dispatch + two failed model attempts, no empty recovery loop
          outageCleared = true;
          await session.prompt("Use the completed background result; do not rerun its task.");
          expect(requests).toHaveLength(4);
          expect(fs.readdirSync(path.join(root, "omp/conversations"))).toHaveLength(1);
        }
        expect(requests.length).toBeGreaterThan(2);
        // Every subsequent request contains the child result, never just another wait.
        for (const request of requests.slice(2)) {
          expect(JSON.stringify(request.messages)).toContain("OMP tasks still running");
          expect(JSON.stringify(request.messages).match(/OMP background delegate finished/g)).toHaveLength(1);
        }
      }
      expect(errors).toEqual([]);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(fs.readdirSync(path.join(root, "omp/sessions"))).toEqual([]);
      expect(fs.readdirSync(path.join(root, "omp/conversations"))).toEqual([]);
    } finally {
      await session?.abort();
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      server.stop(true);
      process.argv[1] = argv;
      if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.each([
  { outcome: "abort", summaryFirst: false },
  { outcome: "complete", summaryFirst: false },
  { outcome: "veto", summaryFirst: false },
  { outcome: "cancel-completed", summaryFirst: false },
  { outcome: "complete", summaryFirst: true },
  { outcome: "veto", summaryFirst: true },
])("native compaction $outcome gates child delivery (summary handler first: $summaryFirst)", async ({ outcome, summaryFirst }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-compaction-abort-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedCapture = process.env.OMP_TEST_CAPTURE;
  const argv = process.argv[1];
  let session: AgentSession | undefined;
  let delegate: any;
  let ctx: any;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let releaseSummary!: () => void;
  const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
  let enteredTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => { enteredTerminal = resolve; });
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json());
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "integrated" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "mock", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
  } });
  let compaction: Promise<unknown> | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.OMP_TEST_CAPTURE = path.join(root, "capture.json");
    process.argv[1] = path.resolve(import.meta.dir, "fixtures/fake-pi.mjs");
    fs.writeFileSync(path.join(root, "omp.json"), "{}");
    fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ providers: { "omp-test": {
      baseUrl: `${server.url.origin}/v1`, api: "openai-completions", apiKey: "offline-test",
      models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 }],
    } } }));
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "omp-test", defaultModel: "mock",
      compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 },
    });
    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Previous discussion. ".repeat(100) }],
      timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant", api: "openai-completions", provider: "omp-test", model: "mock",
      content: [{ type: "text", text: "Previous answer." }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 100, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 103,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        const registerOmp = () => omp({ ...pi, registerTool: (tool) => {
          if (tool.name === "omp_delegate") delegate = tool;
          pi.registerTool(tool);
        } });
        if (!summaryFirst) registerOmp();
        pi.on("session_start", (_event, context) => { ctx = context; });
        pi.on("session_before_compact", async (event) => {
          entered();
          event.signal.addEventListener("abort", releaseSummary, { once: true });
          try {
            if (!event.signal.aborted) await summaryGate;
          } finally {
            event.signal.removeEventListener("abort", releaseSummary);
          }
          if (outcome !== "complete") return { cancel: true };
          return { compaction: {
            summary: "Earlier discussion summarized.",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          } };
        });
        if (summaryFirst) registerOmp();
        pi.on("session_compact", async () => {
          enteredTerminal();
          await terminalGate; // later handlers can delay actual native compaction teardown
        });
      }],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, settingsManager, resourceLoader, sessionManager, noTools: "builtin",
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => { errors.push(error); } });
    await delegate.execute("background", { agent: "fixer", task: `[delay=${outcome === "abort" ? 5000 : 180}] work` },
      undefined, undefined, ctx);
    for (let i = 0; i < 100 && !fs.existsSync(process.env.OMP_TEST_CAPTURE); i++) await Bun.sleep(10);
    expect(fs.existsSync(process.env.OMP_TEST_CAPTURE)).toBe(true);
    const childPid = JSON.parse(fs.readFileSync(process.env.OMP_TEST_CAPTURE, "utf8")).pid;
    compaction = session.compact().catch((error) => error);
    await Promise.race([started, compaction.then((error) => { throw error; })]);
    expect(ctx.signal).toBeUndefined();
    const logDir = path.join(root, "omp/conversations");
    const log = () => fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]!), "utf8");
    expect(log()).not.toContain('"type":"completion"');
    if (outcome === "abort") {
      session.abortCompaction(); // Pi's ESC handler during compaction calls this method
      expect(await compaction).toBeInstanceOf(Error);
      for (let i = 0; i < 100 && !log().includes('"state":"cancelled"'); i++) await Bun.sleep(10);
      expect(log()).toContain('"state":"cancelled"');
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(requests).toHaveLength(0);
    } else {
      for (let i = 0; i < 100 && !log().includes('"state":"done"'); i++) await Bun.sleep(10);
      expect(log()).toContain('"state":"done"');
      await Bun.sleep(80);
      expect(requests).toHaveLength(0); // do not start a model while the summary snapshot is in flight
      if (outcome === "cancel-completed") session.abortCompaction();
      else releaseSummary();
      if (outcome === "complete") {
        await Promise.race([terminal, compaction.then((result) => { throw result; })]);
        await Bun.sleep(80);
        expect(requests).toHaveLength(0); // session_compact is not yet the idle boundary
        releaseTerminal();
      }
      const result = await compaction;
      if (outcome === "complete") expect(result).toHaveProperty("summary", "Earlier discussion summarized.");
      else expect(result).toBeInstanceOf(Error);
      if (outcome === "cancel-completed") {
        for (let i = 0; i < 100 && !JSON.stringify(session.messages).includes("OK fixer"); i++) await Bun.sleep(10);
        expect(JSON.stringify(session.messages)).toContain("OK fixer");
        await Bun.sleep(80);
        expect(requests).toHaveLength(0); // keep the finished result without undoing ESC
      } else {
        for (let i = 0; i < 100 && requests.length === 0; i++) await Bun.sleep(10);
        await session.waitForIdle();
        expect(requests).toHaveLength(1);
        expect(JSON.stringify(requests[0].messages)).toContain("OK fixer");
        expect(JSON.stringify(requests[0].messages).match(/OMP background delegate finished/g)).toHaveLength(1);
      }
    }
    expect(session.isStreaming).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    releaseSummary();
    releaseTerminal();
    session?.abortCompaction();
    await compaction;
    await session?.abort();
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    process.argv[1] = argv;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedCapture === undefined) delete process.env.OMP_TEST_CAPTURE;
    else process.env.OMP_TEST_CAPTURE = savedCapture;
    server.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test.each(["dist/cli.js", "dist/bundle/cli.js"] as const)("real Pi RPC (%s) preserves provider defaults across main, reused children, retries, and cold restores", async (cliPath) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-native-rpc-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const argv = process.argv[1];
  const requests: any[] = [];
  let outage = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      if (requests.length === 1 || outage)
        return new Response(
          JSON.stringify({ error: { message: "Temporary local outage", type: "server_error" } }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      const base = { id: "test", object: "chat.completion.chunk", created: 1, model: "mock" };
      const chunks = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "native result" },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    },
  });
  const sessions = new TaskSessions(120_000, 1);
  let mainSession: AgentSession | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.argv[1] = path.resolve(
      import.meta.dir,
      `../node_modules/@earendil-works/pi-coding-agent/${cliPath}`,
    );
    const dcpPath = path.join(root, "test-dcp.ts");
    fs.writeFileSync(dcpPath, `export default function(pi) {
      pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("dcp", "✂️ DCP: ~683 tokens saved"));
      pi.on("context", (_event, ctx) => ctx.ui.setStatus("dcp", "✂️ DCP: ~701 tokens saved"));
    }`);
    fs.writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({
        extensions: [path.resolve(import.meta.dir, "../extensions/omp/entry.ts"), dcpPath],
        packages: [],
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 50 },
      }),
    );
    fs.writeFileSync(
      path.join(root, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: `${server.url.origin}/v1`,
            api: "openai-completions",
            apiKey: "local-test-only",
            models: [
              {
                id: "mock",
                name: "Local mock",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 128,
              },
            ],
          },
        },
      }),
    );
    fs.writeFileSync(path.join(root, "omp.json"), JSON.stringify({
      fast: true,
      fastProviders: { openai: "openai-priority" },
      serviceTier: { explorer: "priority" },
    }));
    const ctx: any = { cwd: root, isProjectTrusted: () => false };
    const run = (task: string, taskId?: string, onActivity?: (row: AgentProgress) => void) =>
      runAgent(
        ctx,
        { agent: "explorer", task, taskId },
        undefined,
        { model: "openai/mock", thinking: "off" },
        onActivity,
        sessions,
      );
    const activities: string[] = [];
    const phases: string[] = [];
    const dcpStatuses: Array<string | undefined> = [];
    const first = await run("remember the first objective", undefined, (row) => {
      activities.push(row.activity);
      phases.push(row.phase ?? "");
      dcpStatuses.push(row.dcpStatus);
    });
    expect(first.output).toBe("native result");
    expect(first.ok).toBe(true);
    expect(dcpStatuses).toContain("DCP: ~683");
    expect(dcpStatuses).toContain("DCP: ~701");
    expect(first.dcpStatus).toBe("DCP: ~701");
    expect(activities.some((activity) => activity.startsWith("Retrying model request 1/1"))).toBe(
      true,
    );
    expect(activities).toContain("Model request recovered");
    expect(phases).toContain("retrying");
    expect(phases).toContain("model");
    expect(activities.every((activity) => !activity.includes("Temporary local outage"))).toBe(true);
    const second = await run("continue the first objective", first.taskId);
    expect(second.ok).toBe(true);
    expect(
      requests[2].messages.some(
        (message: any) => message.role === "assistant" && message.content === "native result",
      ),
    ).toBe(true);
    expect(JSON.stringify(requests[2].messages)).toContain("remember the first objective");
    expect(requests[0].tools.some((tool: any) => tool.function.name === "omp_delegate")).toBe(
      false,
    );
    expect(requests[0].tools.some((tool: any) => tool.function.name === "websearch")).toBe(true);
    for (const request of requests) expect(request).not.toHaveProperty("service_tier");
    await updateConfig((config) => ({ ...config, thinking: { explorer: "off" } }));
    const reused = await run("continue after changing specialist settings", first.taskId);
    expect(reused.ok).toBe(true);
    expect(JSON.stringify(requests[3].messages)).toContain("continue the first objective");
    await run("independent objective"); // evict the first idle process
    const restored = await run("continue after cold restore", first.taskId);
    expect(restored.ok).toBe(true);
    expect(JSON.stringify(requests[5].messages)).toContain("continue the first objective");
    expect(JSON.stringify(requests[5].messages)).not.toContain("independent objective");
    expect(requests).toHaveLength(6);
    outage = true;
    const failedActivities: string[] = [];
    const failedPhases: string[] = [];
    const failed = await run("retry during outage", undefined, (row) => {
      failedActivities.push(row.activity);
      failedPhases.push(row.phase ?? "");
    });
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain(
      "Model request failed after retry. Inspect partial work before continuing.",
    );
    expect(failed.output).toContain("Temporary local outage");
    expect(failedActivities).toContain("Model request failed after retry");
    expect(failedPhases).toContain("retry-failed");
    expect(requests).toHaveLength(8);
    outage = false;
    const recovered = await run("continue after outage", failed.taskId);
    expect(recovered.ok).toBe(true);
    expect(requests).toHaveLength(9);
    expect(JSON.stringify(requests[8].messages)).toContain("retry during outage");
    for (const request of requests.slice(3)) expect(request).not.toHaveProperty("service_tier");

    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "openai", defaultModel: "mock", compaction: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true,
      noPromptTemplates: true, noContextFiles: true, extensionFactories: [omp],
    });
    await resourceLoader.reload();
    ({ session: mainSession } = await createAgentSession({
      cwd: root, agentDir: root, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(root), noTools: "builtin", thinkingLevel: "off",
    }));
    const extensionErrors: unknown[] = [];
    await mainSession.bindExtensions({ onError: (error) => { extensionErrors.push(error); } });
    await mainSession.prompt("Main session with provider defaults");
    expect(requests[9]).not.toHaveProperty("service_tier");
    await updateConfig((config) => ({ ...config, defaultAgent: "council" }));
    await mainSession.prompt("Main session after changing the default role");
    expect(requests[10]).not.toHaveProperty("service_tier");
    expect(extensionErrors).toEqual([]);
  } finally {
    await mainSession?.abort();
    await mainSession?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    mainSession?.dispose();
    await sessions.clear();
    server.stop(true);
    process.argv[1] = argv;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
