// Local newline-framed stdio MCP test server. It never accesses the network.
import * as fs from "node:fs";
if (process.env.OMP_NATIVE_MCP_STARTED_LOG)
  fs.appendFileSync(process.env.OMP_NATIVE_MCP_STARTED_LOG, "started\n");
process.on("exit", () => {
  if (process.env.OMP_NATIVE_MCP_STOPPED_LOG)
    fs.appendFileSync(process.env.OMP_NATIVE_MCP_STOPPED_LOG, "stopped\n");
});
let buffer = "";
function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function handle(message) {
  if (process.env.OMP_NATIVE_MCP_PROTOCOL_LOG)
    fs.appendFileSync(process.env.OMP_NATIVE_MCP_PROTOCOL_LOG, `${message.method ?? message.id}\n`);
  if (message.method === "initialize") {
    respond({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "offline-gh-grep-fixture", version: "1.0" },
      },
    });
  } else if (message.method === "tools/list") {
    setTimeout(() => respond({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "searchGitHub",
          description: "Search fixture source",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      },
    }), Number(process.env.OMP_NATIVE_MCP_LIST_DELAY_MS ?? 0));
  } else if (message.method === "tools/call") {
    const log = process.env.OMP_NATIVE_MCP_CALL_LOG;
    if (log) fs.appendFileSync(log, JSON.stringify(message.params) + "\n");
    if (message.params.arguments?.waitForCancel) return;
    respond({
      jsonrpc: "2.0",
      id: message.id,
      result: message.params.arguments?.fail
        ? { isError: true, content: [{ type: "text", text: "fixture tool error" }] }
        : { content: [{ type: "text", text: `fixture result: ${message.params.arguments?.query ?? ""}` }] },
    });
  } else if (message.id !== undefined) {
    respond({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
