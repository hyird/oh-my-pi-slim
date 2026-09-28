import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, type AgentProgress } from "../extensions/omp/subagents.ts";
import { TaskSessions } from "../extensions/omp/task-sessions.ts";
import omp from "../extensions/omp/index.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

test.each([true, false])(
  "native goal follow-ups wait for OMP results (goal registered first: %s)",
  async (goalFirst) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-goal-boundary-"));
    const savedDir = process.env.PI_CODING_AGENT_DIR;
    const argv = process.argv[1];
    const requests: any[] = [];
    const errors: unknown[] = [];
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
                      task: "[delay=800] investigate",
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
      });
      // Reproduce the goal plugin's end-of-turn follow-up without depending on it.
      let continuations = 0;
      const goal: ExtensionFactory = (pi) => {
        pi.on("agent_end", () => {
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
      await running;
      expect(requests.length).toBeGreaterThan(2);
      // Every subsequent request contains the child result, never just another wait.
      for (const request of requests.slice(2))
        expect(JSON.stringify(request.messages)).toContain("OMP tasks still running");
      expect(errors).toEqual([]);
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

test("real Pi RPC retries transient failures, stops at exhaustion, and restores native context", async () => {
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
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.argv[1] = path.resolve(
      import.meta.dir,
      "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    );
    fs.writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({
        extensions: [path.resolve(import.meta.dir, "../extensions/omp/entry.ts")],
        packages: [],
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 50 },
      }),
    );
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
                contextWindow: 8192,
                maxTokens: 128,
              },
            ],
          },
        },
      }),
    );
    const ctx: any = { cwd: root, isProjectTrusted: () => false };
    const run = (task: string, taskId?: string, onActivity?: (row: AgentProgress) => void) =>
      runAgent(
        ctx,
        { agent: "explorer", task, taskId },
        undefined,
        { model: "omp-test/mock", thinking: "off" },
        onActivity,
        sessions,
      );
    const activities: string[] = [];
    const phases: string[] = [];
    const first = await run("remember the first objective", undefined, (row) => {
      activities.push(row.activity);
      phases.push(row.phase ?? "");
    });
    expect(first.output).toBe("native result");
    expect(first.ok).toBe(true);
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
    await run("independent objective"); // evict the first idle process
    const restored = await run("continue after cold restore", first.taskId);
    expect(restored.ok).toBe(true);
    expect(JSON.stringify(requests[4].messages)).toContain("continue the first objective");
    expect(JSON.stringify(requests[4].messages)).not.toContain("independent objective");
    expect(requests).toHaveLength(5);
    outage = true;
    const failedActivities: string[] = [];
    const failedPhases: string[] = [];
    const failed = await run("retry during outage", undefined, (row) => {
      failedActivities.push(row.activity);
      failedPhases.push(row.phase ?? "");
    });
    expect(failed.ok).toBe(false);
    expect(failed.output).toBe(
      "Model request failed after retry. Inspect partial work before continuing.",
    );
    expect(failedActivities).toContain("Model request failed after retry");
    expect(failedPhases).toContain("retry-failed");
    expect(requests).toHaveLength(7);
    outage = false;
    const recovered = await run("continue after outage", failed.taskId);
    expect(recovered.ok).toBe(true);
    expect(requests).toHaveLength(8);
    expect(JSON.stringify(requests[7].messages)).toContain("retry during outage");
  } finally {
    await sessions.clear();
    server.stop(true);
    process.argv[1] = argv;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
