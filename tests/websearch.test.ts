import { afterEach, expect, spyOn, test } from "bun:test";
import { parseExaResponse, registerWebSearch, searchExa, type SearchTransport } from "../extensions/omp/websearch.ts";
import { ROLES } from "../extensions/omp/roles.ts";
import { allowedMcpTool } from "../extensions/omp/mcp-policy.ts";

const savedKey = process.env.EXA_API_KEY;
const response = (text: string) => JSON.stringify({
  jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] },
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = savedKey;
});

test("parses JSON results, multiple text blocks and empty searches", () => {
  expect(parseExaResponse(response("Title\nURL: https://example.com\nContent"))).toContain("https://example.com");
  expect(parseExaResponse(JSON.stringify({ id: 1, result: { content: [
    { type: "text", text: "first" }, { type: "image", data: "ignored" }, { type: "text", text: "second" },
  ] } }))).toBe("first\n\nsecond");
  expect(parseExaResponse(JSON.stringify({ id: 1, result: { content: [] } }))).toContain("No search results");
});

test("parses SSE with CRLF, multiline data and notifications", () => {
  const body = `: keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: {"id":1,\r\ndata: "result":{"content":[{"type":"text","text":"found"}]}}\r\n\r\n`;
  expect(parseExaResponse(body)).toBe("found");
  expect(parseExaResponse(`data: ${response("found")}\n\ndata: [DONE]\n\n`)).toBe("found");
  expect(parseExaResponse(JSON.stringify({ id: 2, result: { content: [] } }))).toBeUndefined();
});

test("rejects MCP errors, tool errors and malformed responses", () => {
  for (const body of [
    '{"id":1,"error":{"code":-32603,"message":"private diagnostic"}}',
    '{"id":1,"result":{"isError":true,"content":[]}}',
    '{"id":1,"result":{}}',
    '{broken',
  ]) expect(() => parseExaResponse(body)).toThrow();
});

test("uses the same stateless Exa call and defaults as upstream websearch, without a key", async () => {
  delete process.env.EXA_API_KEY;
  let requested: URL | undefined;
  let init: RequestInit | undefined;
  const transport = (async (url, options) => {
    requested = new URL(String(url));
    init = options;
    return new Response(response("official docs https://example.com"));
  }) as SearchTransport;
  expect(await searchExa({ query: "Pi documentation" }, undefined, transport)).toContain("https://example.com");
  expect(requested?.href).toBe("https://mcp.exa.ai/mcp");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
  expect(JSON.parse(init?.body as string)).toEqual({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: {
      query: "Pi documentation", numResults: 8, livecrawl: "fallback", type: "auto", contextMaxCharacters: 10000,
    } },
  });
});

test("forwards explicit search options and an optional API key", async () => {
  process.env.EXA_API_KEY = "test key & value";
  const options = { query: "latest release", numResults: 3, livecrawl: "preferred", type: "deep", contextMaxCharacters: 1200 } as const;
  const transport = (async (url, init) => {
    expect(new URL(String(url)).searchParams.get("exaApiKey")).toBe("test key & value");
    expect(JSON.parse(init?.body as string).params.arguments).toEqual(options);
    return new Response(response("release notes"));
  }) as SearchTransport;
  expect(await searchExa(options, undefined, transport)).toBe("release notes");
});

test("finishes fragmented SSE immediately after the result without waiting for EOF", async () => {
  const bytes = new TextEncoder().encode(`data: ${response("搜索结果 https://example.com")}\r\n\r\n`);
  let cancelled = false;
  const transport = (async () => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      // Keep the connection open: the completed result must stop reading it.
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } })) as SearchTransport;
  expect(await searchExa({ query: "搜索" }, undefined, transport)).toBe("搜索结果 https://example.com");
  expect(cancelled).toBe(true);
});

test("bounds search output and rejects oversized wire responses", async () => {
  const bounded: SearchTransport = async () => new Response(response("x".repeat(60000)));
  const result = await searchExa({ query: "docs" }, undefined, bounded);
  expect(result).toEndWith("[Search output truncated; narrow the query.]");
  expect(result.length).toBeLessThan(50100);
  const oversized: SearchTransport = async () => new Response("x".repeat(1024 * 1024 + 1));
  await expect(searchExa({ query: "docs" }, undefined, oversized)).rejects.toThrow("Exa search failed");
});

test("reports HTTP, network and malformed-result failures without leaking secrets or retrying", async () => {
  process.env.EXA_API_KEY = "secret-key";
  for (const outcome of [
    () => new Response("private server diagnostic", { status: 429 }),
    () => new Response("not JSON"),
    () => new Response('{"id":1,"error":{"message":"secret-key"}}'),
    () => { throw new Error("secret-key https://mcp.exa.ai/mcp?exaApiKey=secret-key"); },
  ]) {
    let calls = 0;
    const transport: SearchTransport = async () => { calls++; return outcome(); };
    await expect(searchExa({ query: "docs" }, undefined, transport)).rejects.toThrow("Exa search failed; check network access or retry the query");
    expect(calls).toBe(1);
  }
});

test("honors cancellation before a request and during fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const transport: SearchTransport = async () => { calls++; return new Response(response("unused")); };
  await expect(searchExa({ query: "docs" }, controller.signal, transport)).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
  const pendingController = new AbortController();
  const pending = searchExa({ query: "docs" }, pendingController.signal, ((async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as SearchTransport));
  pendingController.abort();
  await expect(pending).rejects.toThrow("cancelled");
});

test("applies the deadline while reading a stalled response body", async () => {
  const original = globalThis.setTimeout;
  const scheduler = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const [callback, ms, ...rest] = args;
    return original(callback, ms === 25_000 ? 5 : ms, ...rest);
  }) as typeof setTimeout);
  const transport: SearchTransport = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    },
  }));
  try {
    await expect(searchExa({ query: "docs" }, undefined, transport)).rejects.toThrow("timed out");
    expect(scheduler).toHaveBeenCalledWith(expect.any(Function), 25_000);
  } finally { scheduler.mockRestore(); }
});

test("registers a read-only websearch tool available to all roles and executes it", async () => {
  let tool: any;
  registerWebSearch({ registerTool: (definition: any) => { tool = definition; } } as any);
  expect(tool.name).toBe("websearch");
  expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  for (const role of Object.values(ROLES)) expect(role.tools).toContain("websearch");
  const tools: any[] = [{ name: "websearch", sourceInfo: { path: "/plugin/extensions/omp/entry.ts" } }];
  for (const role of ["pi", "orchestrator", "council"] as const)
    expect(allowedMcpTool("websearch", role, tools)).toBe(true);
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(new Response(response("cited result")));
  try {
    const result = await tool.execute("search-1", { query: "docs" }, undefined);
    expect(result).toEqual({ content: [{ type: "text", text: "cited result" }], details: { provider: "exa" } });
    await expect(tool.execute("search-2", { query: " " }, undefined)).rejects.toThrow("nonempty");
    expect(transport).toHaveBeenCalledTimes(1);
  } finally { transport.mockRestore(); }
});
