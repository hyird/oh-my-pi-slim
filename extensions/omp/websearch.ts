import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA_URL = "https://mcp.exa.ai/mcp";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 50_000;
const TIMEOUT_MS = 25_000;

export interface SearchOptions {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
}

/** Exa's hosted MCP endpoint accepts a stateless tools/call, as OpenCode websearch does. */
export function parseExaResponse(body: string): string | undefined {
  const payloads = body.trimStart().startsWith("{")
    ? [body]
    : body.replace(/\r\n/g, "\n").split("\n\n").map((event) =>
        event.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n"),
      );
  for (const payload of payloads) {
    if (!payload.trim() || payload.trim() === "[DONE]") continue;
    const message = JSON.parse(payload);
    if (!message || typeof message !== "object" || message.id !== 1) continue;
    if (message.error || message.result?.isError) throw new Error("Exa search returned an error");
    const content = message.result?.content;
    if (!Array.isArray(content)) throw new Error("Invalid Exa search response");
    const text = content.filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("\n\n");
    return text || "No search results found. Try a different query.";
  }
  return undefined;
}

export type SearchTransport = (url: URL, init: RequestInit) => Promise<Response>;

export async function searchExa(
  options: SearchOptions,
  signal?: AbortSignal,
  transport: SearchTransport = fetch,
): Promise<string> {
  const url = new URL(EXA_URL);
  // Optional, like OpenCode. Never include this URL or response bodies in errors.
  if (process.env.EXA_API_KEY) url.searchParams.set("exaApiKey", process.env.EXA_API_KEY);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Exa search timed out")), TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    controller.signal.throwIfAborted();
    const response = await transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: options.query,
            numResults: options.numResults ?? 8,
            livecrawl: options.livecrawl ?? "fallback",
            type: options.type ?? "auto",
            contextMaxCharacters: options.contextMaxCharacters ?? 10_000,
          },
        },
      }),
    });
    reader = response.body?.getReader();
    if (!response.ok) throw new Error(`Exa search failed (HTTP ${response.status})`);
    if (!reader) throw new Error("Empty Exa search response");
    const decoder = new TextDecoder();
    const sse = response.headers.get("content-type")?.includes("text/event-stream");
    let bytes = 0;
    let body = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Exa search response exceeds 1 MiB");
      body += decoder.decode(value, { stream: true });
      if (sse) {
        body = body.replace(/\r\n/g, "\n");
        let end: number;
        while ((end = body.indexOf("\n\n")) !== -1) {
          const result = parseExaResponse(body.slice(0, end));
          body = body.slice(end + 2);
          if (result !== undefined) return limitOutput(result);
        }
      }
    }
    const result = parseExaResponse(body + decoder.decode());
    if (result === undefined) throw new Error("Invalid Exa search response");
    return limitOutput(result);
  } catch {
    // Search queries and optional API keys must not leak through transport diagnostics.
    if (signal?.aborted) throw new Error("Exa search cancelled");
    if (controller.signal.aborted) throw new Error("Exa search timed out");
    throw new Error("Exa search failed; check network access or retry the query");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
  }
}

function limitOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARACTERS
    ? `${text.slice(0, MAX_OUTPUT_CHARACTERS)}\n\n[Search output truncated; narrow the query.]`
    : text;
}

export function registerWebSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "websearch",
    label: "Exa Web Search",
    description: "Search the web through Exa for current information, official docs and sources. Returns relevant page content and URLs. Cite sources and distinguish search results from verified facts. No API key is required by default. Search text is sent to Exa; never include credentials or private data.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 4000, description: "Web search query" }),
      numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Result count (default 8)" })),
      livecrawl: Type.Optional(Type.Union([Type.Literal("fallback"), Type.Literal("preferred")])),
      type: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], { description: "Exa search strategy, not a model service tier (default auto)" })),
      contextMaxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000, description: "Search context length (default 10000)" })),
    }),
    async execute(_id, params, signal) {
      if (!params.query.trim()) throw new Error("A nonempty web search query is required");
      const text = await searchExa(params, signal);
      return { content: [{ type: "text", text }], details: { provider: "exa" } };
    },
  });
}
