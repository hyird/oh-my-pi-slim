// Test-only Pi RPC host. No provider calls or access to real credentials.
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const emit = (event) => console.log(JSON.stringify(event));
const sessionFile = args.includes("--session")
  ? option("--session")
  : path.join(option("--session-dir"), "session.jsonl");
let count = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8")).count : 0;
let busy = false;
let message;
const capture = () => {
  if (!process.env.OMP_TEST_CAPTURE) return;
  const target = process.env.OMP_TEST_CAPTURE;
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify({
      args,
      message,
      count,
      pid: process.pid,
      childGuard: process.env.PI_OMP_CHILD,
      childRole: process.env.PI_OMP_CHILD_ROLE,
      prompt: fs.readFileSync(option("--append-system-prompt"), "utf8"),
    }),
  );
  fs.renameSync(temp, target);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finish = (fail) => ({
  role: "assistant",
  content: [{ type: "text", text: fail ? "failed provider draft" : "Specialist read the task" }],
  stopReason: fail ? "error" : process.env.OMP_TEST_LENGTH ? "length" : "stop",
  errorMessage: fail ? "simulated secret failure" : undefined,
  usage: {
    input: 4,
    output: 5,
    cacheRead: 1,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  },
});
capture();
if (process.env.OMP_TEST_DCP_STARTUP)
  emit({ type: "extension_ui_request", method: "setStatus", statusKey: "dcp",
    statusText: process.env.OMP_TEST_DCP_STARTUP });
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const command = JSON.parse(line);
  if (command.type === "abort") {
    busy = false;
    emit({ type: "response", id: command.id, command: "abort", success: true });
    return;
  }
  if (command.type === "get_state") {
    if (process.env.OMP_TEST_NONFATAL_EXTENSION_ERRORS) {
      const childExtension = option("--extension");
      emit({ type: "extension_error", extensionPath: childExtension, event: "session_start", error: "ordinary extension warning" });
      emit({
        type: "extension_error",
        extensionPath: path.join(path.dirname(childExtension), "other-extension.ts"),
        event: "session_start",
        error: "OMP child native MCP isolation failed: unrelated source",
      });
    }
    if (process.env.OMP_TEST_STARTUP_MCP_EXTENSION_ERROR) {
      emit({
        type: "extension_error",
        extensionPath: option("--extension"),
        event: "session_start",
        error: "OMP child native MCP isolation failed: fixture startup collision access_token=fixture-secret",
      });
      return;
    }
    emit({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: { isStreaming: busy, isCompacting: false, pendingMessageCount: 0, sessionFile },
    });
    return;
  }
  if (command.type !== "prompt") return;
  message = command.message;
  count++;
  busy = true;
  fs.writeFileSync(sessionFile, JSON.stringify({ count }));
  capture();
  emit({ type: "response", id: command.id, command: "prompt", success: true });
  if (process.env.OMP_TEST_MCP_EXTENSION_ERROR) {
    emit({
      type: "extension_error",
      extensionPath: option("--extension"),
      event: "before_agent_start",
      error: "OMP child native MCP isolation failed: fixture command collision access_token=fixture-secret",
    });
    return;
  }
  emit({ type: "agent_start" });
  for (const status of JSON.parse(process.env.OMP_TEST_DCP_EVENTS ?? "[]"))
    emit({ type: "extension_ui_request", method: "setStatus", ...status });
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Inspecting the code" },
  });
  if (process.env.OMP_TEST_TOOL_SUMMARY) {
    emit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash",
      args: { command: "rg -n 'resolveRootTask|WorkerHandle|PMR' src/core/tasks/event-loop.ts src/core/tasks/root-task.ts" } });
    emit({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: false,
      result: { content: [{ type: "text", text: "SECRET_COMMAND_BODY" }] } });
    emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read",
      args: { path: "src/core/tasks/event-loop/RootTask/WorkerHandle/internal/deeply-nested-source-file.ts" } });
    emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false,
      result: { content: [{ type: "text", text: "SECRET_READ_BODY" }] } });
    emit({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit",
      args: { path: "src/core/tasks/event-loop/RootTask/WorkerHandle/internal/deeply-nested-source-file.ts", edits: [{ oldText: "SECRET_OLD", newText: "SECRET_NEW" }] } });
    emit({ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: false,
      result: { content: [{ type: "text", text: "SECRET_EDIT_BODY" }],
        details: { diff: "-1 SECRET_OLD\n+1 SECRET_NEW\n+2 extra", patch: "SECRET_PATCH_BODY" } } });
    emit({ type: "tool_execution_start", toolCallId: "edit-2", toolName: "edit",
      args: { path: "src/core/tasks/event-loop/RootTask/WorkerHandle/internal/deeply-nested-source-file.ts", edits: [{ oldText: "SECRET_OLD_2", newText: "SECRET_NEW_2" }] } });
    emit({ type: "tool_execution_end", toolCallId: "edit-2", toolName: "edit", isError: false,
      result: { content: [{ type: "text", text: "SECRET_EDIT_BODY_2" }],
        details: { diff: "-3 old\n-4 old\n+3 new" } } });
  } else {
    for (let i = 0; i < (process.env.OMP_TEST_ACTIVITIES ? 35 : 1); i++) {
      emit({
        type: "tool_execution_start",
        toolCallId: "tool-" + i,
        toolName: "read",
        args: { path: process.env.OMP_TEST_ACTIVITIES ? "file-" + i : "src/index.ts" },
      });
      if (!process.env.OMP_TEST_ACTIVITIES)
        emit({
          type: "tool_execution_end",
          toolCallId: "tool-" + i,
          toolName: "read",
          isError: false,
        });
    }
  }
  const delay = /\[delay=(\d+)\]/.exec(message)?.[1] ?? process.env.OMP_TEST_WAIT_MS ?? 0;
  await sleep(Number(delay));
  if (process.env.OMP_TEST_RETRY) {
    emit({ type: "message_end", message: finish(true) });
    emit({ type: "agent_end", willRetry: true });
    emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 40,
      errorMessage: "simulated secret failure",
    });
    await sleep(40);
    emit({ type: "message_start", message: { role: "assistant" } });
  }
  emit({ type: "message_end", message: finish(!!process.env.OMP_TEST_FAIL) });
  if (process.env.OMP_TEST_RETRY)
    emit({ type: "auto_retry_end", success: !process.env.OMP_TEST_FAIL, attempt: 1 });
  emit({ type: "agent_end", willRetry: false });
  await sleep(Number(process.env.OMP_TEST_SETTLE_WAIT_MS ?? 0));
  busy = false;
  emit({ type: "agent_settled" });
  if (process.env.OMP_TEST_DUPLICATE) emit({ type: "agent_settled" });
});
input.on("close", () =>
  setTimeout(() => process.exit(0), Number(process.env.OMP_TEST_EXIT_WAIT_MS ?? 0)),
);
