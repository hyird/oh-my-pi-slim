import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROLE_NAMES = ["explorer", "librarian", "oracle", "designer", "fixer", "council"] as const;

test("real Pi parent discovery, role permissions, continuation changes, and DCP startup fail-closed checks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-dcp-"));
  const requests: any[] = [];
  let expectToolCall = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const hasFixture = body.tools?.some((tool: any) => tool.function?.name === "dcp_fixture_tool");
      const callTool = expectToolCall && hasFixture;
      if (hasFixture) expectToolCall = !callTool;
      else expectToolCall = true;
      const base = { id: "dcp-test", object: "chat.completion.chunk", created: 1, model: "mock" };
      const delta = callTool
        ? { role: "assistant", tool_calls: [{ index: 0, id: "dcp-call", type: "function", function: { name: "dcp_fixture_tool", arguments: "{}" } }] }
        : { role: "assistant", content: "fixture response" };
      const chunks = [
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop" }] },
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  try {
    fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: `${server.url.origin}/v1`, api: "openai-completions", apiKey: "local-only", models: [{
        id: "mock", name: "Local mock", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128,
      }] },
    } }));
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ extensions: [], packages: [] }));
    const repoRoot = path.resolve(import.meta.dir, "..");
    const providerPath = path.join(repoRoot, "tests/fixtures/dcp-provider/index.ts");
    const foreignPath = path.join(repoRoot, "tests/fixtures/foreign-dcp/index.ts");
    const cliPath = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const script = `
      import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
      import { discoverDcpTools } from ${JSON.stringify(path.join(repoRoot, "extensions/omp/dcp-tools.ts"))};
      import { runAgent } from ${JSON.stringify(path.join(repoRoot, "extensions/omp/subagents.ts"))};
      import { TaskSessions } from ${JSON.stringify(path.join(repoRoot, "extensions/omp/task-sessions.ts"))};
      process.argv[1] = ${JSON.stringify(cliPath)};
      delete process.env.OMP_DCP_FIXTURE_MODE;
      const cwd = ${JSON.stringify(root)};
      const providerPath = ${JSON.stringify(providerPath)};
      const foreignPath = ${JSON.stringify(foreignPath)};
      const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, additionalExtensionPaths: [providerPath], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
      await loader.reload();
      if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
      const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, sessionManager: SessionManager.inMemory(), tools: ["dcp_fixture_tool"] });
      try {
        session.setActiveToolsByName(["dcp_fixture_tool"]);
        const parentApi = { getAllTools: () => session.getAllTools(), getActiveTools: () => session.getActiveToolNames() };
        const snapshot = discoverDcpTools(parentApi as any);
        if (snapshot.tools.join(",") !== "dcp_fixture_tool") throw new Error("actual Pi parent registry was not discovered: " + JSON.stringify(snapshot));
        const registered = session.getAllTools().find((tool) => tool.name === "dcp_fixture_tool")!;
        const collisionNames = ["context_pack,bash", " bash ", "bash", "edit", "write", "bad\tname"];
        const hostileApi = {
          getAllTools: () => [...session.getAllTools(), ...collisionNames.map((name) => ({ ...registered, name }))],
          getActiveTools: () => [...session.getActiveToolNames(), ...collisionNames],
        };
        const hostileSnapshot = discoverDcpTools(hostileApi as any);
        if (JSON.stringify(hostileSnapshot) !== JSON.stringify(snapshot)) throw new Error("unsafe DCP tool names survived filtering: " + JSON.stringify(hostileSnapshot));
        const sessions = new TaskSessions(0, 0);
        const ctx = { cwd, isProjectTrusted: () => false };
        const results = [];
        for (const agent of ${JSON.stringify(ROLE_NAMES)}) {
          const tools = ["explorer", "oracle", "council"].includes(agent) ? hostileSnapshot : snapshot;
          results.push(await runAgent(ctx, { agent, task: "Run the local DCP fixture." }, undefined, { model: "openai/mock", thinking: "off" }, undefined, sessions, undefined, tools));
        }
        const expected = { providers: [{ path: providerPath, tools: ["dcp_fixture_tool"] }], tools: ["dcp_fixture_tool"], signature: "expected" };
        const failures = [];
        for (const mode of ["missing", "loadfail", "unregistered", "foreign"]) {
          process.env.OMP_DCP_FIXTURE_MODE = mode;
          const badProviders = mode === "foreign"
            ? [...expected.providers, { path: foreignPath, tools: [] }]
            : expected.providers;
          const badSnapshot = { providers: badProviders, tools: expected.tools, signature: JSON.stringify(badProviders) };
          const result = await runAgent(ctx, { agent: "explorer", task: "Must fail before model work." }, undefined, { model: "openai/mock", thinking: "off" }, undefined, sessions, undefined, badSnapshot);
          failures.push({ mode, ok: result.ok, output: result.output });
        }
        delete process.env.OMP_DCP_FIXTURE_MODE;
        const continuation = results[0];
        session.setActiveToolsByName([]);
        const removed = discoverDcpTools({ getAllTools: () => session.getAllTools(), getActiveTools: () => session.getActiveToolNames() } as any);
        const resumed = await runAgent(ctx, { agent: "explorer", taskId: continuation.taskId, task: "Continue after DCP was disabled." }, undefined, { model: "openai/mock", thinking: "off" }, undefined, sessions, undefined, removed);
        console.log(JSON.stringify({ snapshot, roles: results.map(({ agent, ok, output, taskId }) => ({ agent, ok, output, taskId })), failures, removedTools: removed.tools, resumed: { ok: resumed.ok, taskId: resumed.taskId } }));
        await sessions.clear();
      } finally { session.dispose(); }
    `;
    const child = Bun.spawn([process.execPath, "--bun", "-e", script], {
      cwd: repoRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.snapshot.tools).toEqual(["dcp_fixture_tool"]);
    expect(result.roles.map((role: any) => role.agent)).toEqual([...ROLE_NAMES]);
    expect(result.roles.every((role: any) => role.ok && role.output === "fixture response")).toBe(true);
    expect(result.failures.map((failure: any) => failure.mode)).toEqual(["missing", "loadfail", "unregistered", "foreign"]);
    expect(result.failures.every((failure: any) => !failure.ok)).toBe(true);
    expect(result.failures.find((failure: any) => failure.mode === "loadfail").output).toContain("local fixture provider load failure");
    expect(result.removedTools).toEqual([]);
    expect(result.resumed.ok).toBe(true);
    expect(requests).toHaveLength(13);
    for (let i = 0; i < ROLE_NAMES.length; i++) {
      const first = requests[i * 2];
      const names = first.tools.map((tool: any) => tool.function.name);
      expect(names).toContain("dcp_fixture_tool");
      if (["explorer", "oracle", "council"].includes(ROLE_NAMES[i]!)) {
        expect(names).not.toContain("bash");
        expect(names).not.toContain("edit");
        expect(names).not.toContain("write");
      }
    }
    for (const failure of ["missing", "loadfail", "unregistered", "foreign"]) {
      expect(requests.filter((request) => JSON.stringify(request).includes(failure))).toHaveLength(0);
    }
    const afterRemoved = requests[12].tools.map((tool: any) => tool.function.name);
    expect(afterRemoved).not.toContain("dcp_fixture_tool");
  } finally {
    server.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
