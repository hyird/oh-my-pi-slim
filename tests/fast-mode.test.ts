import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerFastMode from "../extensions/omp/fast-mode.ts";
import { configPath, updateConfig } from "../extensions/omp/config.ts";

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

test("invalid shared Fast mode settings are reported rather than coerced", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ fast: "on" }));
  expect(() => request({ payload: {} }, { model: { provider: "openai", api: "openai-responses" } }))
    .toThrow("fast must be a boolean");
});
