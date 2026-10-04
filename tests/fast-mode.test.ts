import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerFastMode from "../extensions/omp/fast-mode.ts";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { configPath, parseConfig, readConfig, updateConfig } from "../extensions/omp/config.ts";

const savedDir = process.env.PI_CODING_AGENT_DIR;
let root: string;
let request: (event: any, ctx: any) => unknown;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fast-"));
  process.env.PI_CODING_AGENT_DIR = root;
  registerFastMode({ on: (event: string, handler: any) => {
    expect(event).toBe("before_provider_request");
    request = handler;
  } } as any);
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedDir;
  fs.rmSync(root, { recursive: true, force: true });
});

test.each([
  ["openai", "openai-responses"],
  ["openai", "openai-completions"],
  ["openai", "openai-codex-responses"],
  ["openai-codex", "openai-codex-responses"],
  ["codex-account", "openai-codex-responses"],
])("Fast mode follows the shared switch on every %s / %s request", async (provider, api) => {
  const ctx = { model: { provider, api } };
  const payload = { model: "fixture", service_tier: "default", reasoning: { effort: "high" } };
  expect(request({ payload }, ctx)).toBeUndefined();
  await updateConfig((config) => ({ ...config, fast: true }));
  expect(request({ payload }, ctx)).toEqual({ ...payload, service_tier: "priority" });
  expect(payload.service_tier).toBe("default");
  await updateConfig((config) => ({ ...config, fast: false }));
  expect(request({ payload }, ctx)).toBeUndefined();
  expect(payload.service_tier).toBe("default");
});

test("Fast mode does not alter unsupported providers or non-object payloads", async () => {
  await updateConfig((config) => ({ ...config, fast: true }));
  for (const model of [undefined,
    { provider: "anthropic", api: "anthropic-messages" },
    { provider: "custom-proxy", api: "openai-completions" },
    { provider: "custom-proxy", api: "openai-responses" },
  ]) expect(request({ payload: {} }, { model })).toBeUndefined();
  for (const payload of [undefined, null, [], "payload"])
    expect(request({ payload }, { model: { provider: "openai", api: "openai-responses" } })).toBeUndefined();
});

test.each(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"])("Claude %s enables native Fast mode and preserves beta features", async (id) => {
  const ctx = { model: { provider: "anthropic", api: "anthropic-messages", id } };
  const payload = { model: id, betas: ["existing-beta"], speed: "standard", max_tokens: 1234 };
  await updateConfig((config) => ({ ...config, fast: true }));
  const result: any = request({ payload }, ctx);
  expect(result).toEqual({ ...payload, speed: "fast", betas: ["existing-beta", "fast-mode-2026-02-01"] });
  expect(request({ payload: result }, ctx)).toEqual(result);
  expect(payload.betas).toEqual(["existing-beta"]);
  expect(payload.speed).toBe("standard");
  await updateConfig((config) => ({ ...config, fast: false }));
  expect(request({ payload }, ctx)).toBeUndefined();
});

test("unsupported Claude models and other Anthropic-protocol hosts are not assumed to support Fast", async () => {
  await updateConfig((config) => ({ ...config, fast: true }));
  for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-4-6", "claude-future"]) {
    expect(request({ payload: {} }, { model: { provider: "anthropic", api: "anthropic-messages", id } })).toBeUndefined();
  }
  expect(request({ payload: {} }, { model: { provider: "github-copilot", api: "anthropic-messages", id: "claude-opus-5-5" } })).toBeUndefined();
});

test("Groq selects the best tier available instead of sending OpenAI's invalid priority tier", async () => {
  await updateConfig((config) => ({ ...config, fast: true }));
  const ctx = { model: { provider: "groq", api: "openai-completions" } };
  const payload = { service_tier: "on_demand", temperature: 0.2 };
  expect(request({ payload }, ctx)).toEqual({ ...payload, service_tier: "auto" });
  expect(payload.service_tier).toBe("on_demand");
  await updateConfig((config) => ({ ...config, fastProviders: { groq: "groq-performance" } }));
  expect(request({ payload }, ctx)).toEqual({ ...payload, service_tier: "performance" });
});

test.each([
  ["proxy", "openai-responses", "openai-priority", { service_tier: "priority" }],
  ["azure", "azure-openai-responses", "openai-priority", { service_tier: "priority" }],
  ["claude-proxy", "anthropic-messages", "anthropic-fast", { speed: "fast", betas: ["fast-mode-2026-02-01"] }],
  ["cerebras-dedicated", "openai-completions", "cerebras-auto", { service_tier: "auto" }],
  ["amazon-bedrock", "bedrock-converse-stream", "bedrock-priority", { serviceTier: { type: "priority" } }],
] as const)("declared %s capability follows the same master switch", async (provider, api, mode, expected) => {
  const ctx = { model: { provider, api, id: "supported-model" } };
  await updateConfig((config) => ({ ...config, fastProviders: { [provider]: mode } }));
  expect(request({ payload: { keep: true } }, ctx)).toBeUndefined();
  await updateConfig((config) => ({ ...config, fast: true }));
  expect(request({ payload: { keep: true } }, ctx)).toEqual({ keep: true, ...expected });
  await updateConfig((config) => ({ ...config, fast: false }));
  expect(request({ payload: {} }, ctx)).toBeUndefined();
  expect(readConfig().fastProviders?.[provider]).toBe(mode);
});

test("model-scoped capability declarations override provider-wide settings without activating other models", async () => {
  await updateConfig((config) => ({ ...config, fast: true, fastProviders: {
    "custom/supported": "openai-priority", openai: "openai-priority", "openai/excluded": "off",
  } }));
  const model = { provider: "custom", api: "openai-completions", id: "supported" };
  expect(request({ payload: {} }, { model })).toEqual({ service_tier: "priority" });
  expect(request({ payload: {} }, { model: { ...model, id: "unknown" } })).toBeUndefined();
  expect(request({ payload: {} }, { model: { ...model, provider: "openai", id: "excluded" } })).toBeUndefined();
});

test("capability profiles cannot inject fields into the wrong protocol", async () => {
  for (const mode of ["openai-priority", "anthropic-fast", "groq-auto", "cerebras-auto", "bedrock-priority"] as const) {
    await updateConfig((config) => ({ ...config, fast: true, fastProviders: { custom: mode } }));
    expect(request({ payload: {} }, { model: { provider: "custom", api: "google-generative-ai" } })).toBeUndefined();
  }
});

test("undeclared dedicated-endpoint or transport-specific capabilities do not leak across providers", async () => {
  await updateConfig((config) => ({ ...config, fast: true }));
  for (const [provider, api] of [
    ["cerebras", "openai-completions"], ["amazon-bedrock", "bedrock-converse-stream"],
    ["google", "google-generative-ai"], ["google-vertex", "google-vertex"],
  ]) expect(request({ payload: {} }, { model: { provider, api } })).toBeUndefined();
});

test("Fast capability declarations are validated and retained across settings updates", async () => {
  for (const fastProviders of [true, [], null, { openai: true }, { openai: "priority" }, { "bad name": "off" }]) {
    expect(() => parseConfig({ fastProviders })).toThrow();
  }
  expect(() => parseConfig(JSON.parse('{"fastProviders":{"__proto__":"off"}}'))).toThrow();
  const config = parseConfig({ fastProviders: { constructor: "off" } });
  expect(Object.hasOwn(config.fastProviders!, "constructor")).toBe(true);
  expect(Object.getPrototypeOf(config.fastProviders)).toBe(Object.prototype);
});

test("Anthropic's native SDK converts the Fast beta into a header while preserving speed in the body", async () => {
  await updateConfig((config) => ({ ...config, fast: true }));
  const model: Model<"anthropic-messages"> = {
    provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5", name: "Fixture",
    baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  };
  let headers: Headers | undefined;
  let body: any;
  const events = [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: model.id,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const response = await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }), {
    apiKey: "fixture-not-a-real-key", maxRetries: 0,
    onPayload: (payload) => request({ payload }, { model }),
    fetch: (async (_url: any, init: any) => {
      headers = new Headers(init.headers);
      body = JSON.parse(init.body);
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  }).result();
  expect(response.stopReason).toBe("stop");
  expect(headers?.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
  expect(body.speed).toBe("fast");
  expect(body.betas).toBeUndefined();
});

test("invalid shared Fast mode settings are reported rather than coerced", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ fast: "on" }));
  expect(() => request({ payload: {} }, { model: { provider: "openai", api: "openai-responses" } }))
    .toThrow("fast must be a boolean");
});
