// Test-only Pi RPC host. No provider calls or access to real credentials.
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const emit = event => console.log(JSON.stringify(event));
const sessionFile = args.includes("--session") ? option("--session") : path.join(option("--session-dir"), "session.jsonl");
let count = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8")).count : 0;
let busy = false;
let message;
const capture = () => {
  if (!process.env.OMP_TEST_CAPTURE) return;
  fs.writeFileSync(process.env.OMP_TEST_CAPTURE, JSON.stringify({ args, message, count, pid: process.pid,
    childGuard: process.env.PI_OMP_CHILD, serviceTier: process.env.PI_OMP_SERVICE_TIER,
    mcpMode: process.env.PI_MCP_CONFIG_MODE,
    mcpConfig: args.includes("--mcp-config") ? JSON.parse(fs.readFileSync(option("--mcp-config"), "utf8")) : undefined,
    prompt: fs.readFileSync(option("--append-system-prompt"), "utf8"),
  }));
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = fail => ({ role: "assistant", content: [{ type: "text", text: "Specialist read the task" }], stopReason: fail ? "error" : "stop", errorMessage: fail ? "simulated secret failure" : undefined, usage: {
  input: 4, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 10,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
} });
capture();
const input = createInterface({ input: process.stdin });
input.on("line", async line => {
  const command = JSON.parse(line);
  if (command.type === "abort") {
    busy = false;
    emit({ type: "response", id: command.id, command: "abort", success: true });
    return;
  }
  if (command.type === "get_state") {
    emit({ type: "response", id: command.id, command: command.type, success: true,
      data: { isStreaming: busy, isCompacting: false, pendingMessageCount: 0, sessionFile } });
    return;
  }
  if (command.type !== "prompt") return;
  message = command.message;
  count++;
  busy = true;
  fs.writeFileSync(sessionFile, JSON.stringify({ count }));
  capture();
  emit({ type: "response", id: command.id, command: "prompt", success: true });
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Inspecting the code" } });
  for (let i = 0; i < (process.env.OMP_TEST_ACTIVITIES ? 35 : 1); i++) {
    emit({ type: "tool_execution_start", toolCallId: "tool-" + i, toolName: "read", args: { path: process.env.OMP_TEST_ACTIVITIES ? "file-" + i : "src/index.ts" } });
    if (!process.env.OMP_TEST_ACTIVITIES) emit({ type: "tool_execution_end", toolCallId: "tool-" + i, toolName: "read", isError: false });
  }
  const delay = /\[delay=(\d+)\]/.exec(message)?.[1] ?? process.env.OMP_TEST_WAIT_MS ?? 0;
  await sleep(Number(delay));
  if (process.env.OMP_TEST_RETRY) {
    emit({ type: "message_end", message: finish(true) });
    emit({ type: "agent_end", willRetry: true });
    await sleep(40);
    emit({ type: "message_start", message: { role: "assistant" } });
  }
  emit({ type: "message_end", message: finish(!!process.env.OMP_TEST_FAIL) });
  emit({ type: "agent_end", willRetry: false });
  await sleep(Number(process.env.OMP_TEST_SETTLE_WAIT_MS ?? 0));
  busy = false;
  emit({ type: "agent_settled" });
  if (process.env.OMP_TEST_DUPLICATE) emit({ type: "agent_settled" });
});
input.on("close", () => setTimeout(() => process.exit(0), Number(process.env.OMP_TEST_EXIT_WAIT_MS ?? 0)));
