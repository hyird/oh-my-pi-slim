import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent } from "../extensions/omp/subagents.ts";
import { TaskSessions } from "../extensions/omp/task-sessions.ts";

test("real Pi RPC completes and restores native context against a local mock provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-native-rpc-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const argv = process.argv[1];
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const base = { id: "test", object: "chat.completion.chunk", created: 1, model: "mock" };
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "native result" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const sessions = new TaskSessions(120_000, 1);
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.argv[1] = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
      extensions: [path.resolve(import.meta.dir, "../extensions/omp/entry.ts")], packages: [],
    }));
    fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ providers: {
      "omp-test": { baseUrl: `${server.url.origin}/v1`, api: "openai-completions", apiKey: "local-test-only", models: [
        { id: "mock", name: "Local mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 },
      ] },
    } }));
    const ctx: any = { cwd: root, isProjectTrusted: () => false };
    const run = (task: string, taskId?: string) => runAgent(ctx, { agent: "explorer", task, taskId }, undefined, { model: "omp-test/mock", thinking: "off" }, undefined, sessions);
    const first = await run("remember the first objective");
    expect(first.output).toBe("native result");
    expect(first.ok).toBe(true);
    const second = await run("continue the first objective", first.taskId);
    expect(second.ok).toBe(true);
    expect(requests[1].messages.some((message: any) => message.role === "assistant" && message.content === "native result")).toBe(true);
    expect(JSON.stringify(requests[1].messages)).toContain("remember the first objective");
    expect(requests[0].tools.some((tool: any) => tool.function.name === "omp_delegate")).toBe(false);
    await run("independent objective"); // evict the first idle process
    const restored = await run("continue after cold restore", first.taskId);
    expect(restored.ok).toBe(true);
    expect(JSON.stringify(requests[3].messages)).toContain("continue the first objective");
    expect(JSON.stringify(requests[3].messages)).not.toContain("independent objective");
    expect(requests).toHaveLength(4);
  } finally {
    await sessions.clear();
    server.stop(true);
    process.argv[1] = argv;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
