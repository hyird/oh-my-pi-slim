import { expect, test } from "bun:test";
import { assistantReplies, safeText, ReplyAccumulator } from "../extensions/omp/conversation-content.ts";

test("task cards show only assistant replies and replace streamed drafts", () => {
  const events = [
    { type: "message_end", message: { role: "user", content: "private task" } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hidden reasoning" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "draft" } },
    { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "private output" }] } },
    { type: "message_end", message: { role: "assistant", content: [
      { type: "text", text: "final reply" }, { type: "toolCall", name: "bash", arguments: { command: "private command" } },
    ] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next " } },
    { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "next reply" } },
  ];
  expect(assistantReplies(events)).toEqual(["final reply", "next reply"]);
  expect(JSON.stringify(assistantReplies(events))).not.toMatch(/private|hidden|draft/);
});

test("child output cannot inject terminal controls into cards", () => {
  expect(safeText("hello\x1b[2J\x1b]0;bad\x07\tworld\x00")).toBe("hello    world");
  expect(assistantReplies([{ type: "message_end", message: { role: "assistant", content: [
    { type: "thinking", thinking: "hidden" }, { type: "text", text: "safe\x1b[1G reply" },
  ] } }])).toEqual(["safe reply"]);
});


test("incremental replies replace drafts, exclude tool data, and remain bounded", () => {
  const replies = new ReplyAccumulator(100);
  replies.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "draft" } });
  expect(replies.text()).toBe("draft");
  replies.record({ type: "tool_execution_end", result: { content: "secret" } });
  expect(replies.text()).toBe("draft");
  replies.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }, { type: "thinking", thinking: "hidden" }] } });
  expect(replies.text()).toBe("final");
  for (let i = 0; i < 1000; i++) replies.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: i, delta: "x".repeat(1000) } });
  expect(replies.text().length).toBeLessThanOrEqual(100);
  expect(replies.text()).not.toMatch(/draft|secret|hidden/);
  replies.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "next" }] } });
  expect(replies.text()).toBe("final\n\nnext");
});
