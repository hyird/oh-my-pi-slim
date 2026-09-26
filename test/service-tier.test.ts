import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import omp from "../extensions/omp/index.ts";
import { parseConfig, updateConfig } from "../extensions/omp/config.ts";
import { runAgent, resolveLaunches } from "../extensions/omp/subagents.ts";
import { installChildServiceTier } from "../extensions/omp/service-tier.ts";

const keys = ["PI_OMP_CHILD", "PI_OMP_SERVICE_TIER", "PI_CODING_AGENT_DIR", "OMP_TEST_CAPTURE"] as const;
let saved: Array<string | undefined>;
let root: string;
let argv: string;
beforeEach(() => {
  saved = keys.map(key => process.env[key]);
  argv = process.argv[1];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-speed-test-"));
  process.env.PI_CODING_AGENT_DIR = root;
});
afterEach(() => {
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  process.argv[1] = argv;
  fs.rmSync(root, { recursive: true, force: true });
});

test("speed config accepts specialist tiers and rejects invalid or main-role overrides", () => {
  expect(parseConfig({ serviceTier: { explorer: "priority", fixer: "default" } }).serviceTier).toEqual({ explorer: "priority", fixer: "default" });
  for (const serviceTier of [null, [], "fast", { explorer: "fast" }, { explorer: true }, { council: "priority" }, { orchestrator: "priority" }, { invalid: "priority" }]) {
    expect(() => parseConfig({ serviceTier })).toThrow("serviceTier");
  }
});

test("only child requests for OpenAI providers receive the selected tier", () => {
  const handlers: Record<string, any> = {};
  const pi: any = { on: (name: string, fn: any) => { handlers[name] = fn; } };
  process.env.PI_OMP_SERVICE_TIER = "priority";
  delete process.env.PI_OMP_CHILD;
  installChildServiceTier(pi);
  expect(Object.keys(handlers)).toEqual([]);
  process.env.PI_OMP_CHILD = "1";
  omp(pi); // child registers just the request hook, no UI, timers, or OMP tools
  expect(Object.keys(handlers)).toEqual(["before_provider_request"]);
  const payload = { model: "gpt-6-luna", input: [], service_tier: "default" };
  for (const provider of ["openai", "openai-codex"]) {
    expect(handlers.before_provider_request({ payload }, { model: { provider } })).toEqual({ ...payload, service_tier: "priority" });
  }
  expect(payload.service_tier).toBe("default");
  expect(handlers.before_provider_request({ payload }, { model: { provider: "anthropic" } })).toBeUndefined();
  expect(handlers.before_provider_request({ payload: null }, { model: { provider: "openai" } })).toBeUndefined();
  process.env.PI_OMP_SERVICE_TIER = "default";
  installChildServiceTier(pi);
  expect(handlers.before_provider_request({ payload: { model: "gpt-6-luna" } }, { model: { provider: "openai" } }).service_tier).toBe("default");
});

test("child launch snapshots Fast per role without inheriting it into other children", async () => {
  const model = { provider: "openai-codex", id: "gpt-6-luna" };
  const ctx: any = { cwd: root, model, modelRegistry: { getAvailable: () => [model] }, isProjectTrusted: () => false };
  const config = await updateConfig(c => ({ ...c, serviceTier: { explorer: "priority", fixer: "default" } }));
  const launches = resolveLaunches(ctx, [{ agent: "explorer", task: "inspect" }, { agent: "fixer", task: "fix" }], { config, available: [model] as any });
  // Subsequent config edits must not change the already resolved batch.
  await updateConfig(c => ({ ...c, serviceTier: { explorer: "default" } }));
  process.argv[1] = path.resolve(import.meta.dir, "fake-pi.mjs");
  process.env.OMP_TEST_CAPTURE = path.join(root, "capture.json");
  process.env.PI_OMP_SERVICE_TIER = "priority";
  const captured = () => JSON.parse(fs.readFileSync(process.env.OMP_TEST_CAPTURE!, "utf8"));
  expect((await runAgent(ctx, { agent: "explorer", task: "inspect" }, undefined, launches.get("explorer"))).ok).toBe(true);
  expect(captured().serviceTier).toBe("priority");
  await runAgent(ctx, { agent: "fixer", task: "fix" }, undefined, launches.get("fixer"));
  expect(captured().serviceTier).toBe("default");
  await runAgent(ctx, { agent: "oracle", task: "review" }, undefined, { model: "openai-codex/gpt-6-luna" });
  expect(captured().serviceTier).toBeUndefined();
  await runAgent(ctx, { agent: "council", task: "review" }, undefined, { model: "openai-codex/gpt-6-luna", serviceTier: "priority" });
  expect(captured().serviceTier).toBeUndefined();
  await runAgent(ctx, { agent: "fixer", task: "fix" }, undefined, { model: "anthropic/test", serviceTier: "priority" });
  expect(captured().serviceTier).toBeUndefined();
});
