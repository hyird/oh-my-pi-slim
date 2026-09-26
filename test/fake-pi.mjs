// Test-only fake Pi CLI. No provider calls and no access to real credentials.
import * as fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.OMP_TEST_CAPTURE) {
  fs.writeFileSync(process.env.OMP_TEST_CAPTURE, JSON.stringify({ args, childGuard: process.env.PI_OMP_CHILD, serviceTier: process.env.PI_OMP_SERVICE_TIER, mcpMode: process.env.PI_MCP_CONFIG_MODE, mcpConfig: args.includes("--mcp-config") ? JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")) : undefined, prompt: fs.readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8") }));
}
console.log(JSON.stringify({ type: "message_start", message: { role: "assistant" } }));
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Inspecting the code" } }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "src/index.ts" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", isError: false }));
if (process.env.OMP_TEST_WAIT_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.OMP_TEST_WAIT_MS)));
const message = { role: "assistant", content: [{ type: "text", text: "Specialist read the task" }], stopReason: process.env.OMP_TEST_FAIL ? "error" : "stop", errorMessage: process.env.OMP_TEST_FAIL ? "simulated failure" : undefined, usage: {
  input: 4, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 10,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
} };
console.log(JSON.stringify({ type: "message_end", message }));
