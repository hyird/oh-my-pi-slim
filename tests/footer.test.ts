import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installUsageFooter } from "../extensions/omp/footer.ts";
import { ChildUsageLedger, addUsage, emptyUsage } from "../extensions/omp/usage.ts";

function footer() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "assistant", provider: "test", model: "main-model", api: "openai-responses",
    content: [], timestamp: 1, stopReason: "stop",
    usage: addUsage(emptyUsage(), { input: 1000, output: 20, cacheRead: 2000, cacheWrite: 30 }) });
  const children = new ChildUsageLedger();
  children.record("child", addUsage(emptyUsage(), { input: 50, output: 40, cacheRead: 60, cacheWrite: 10 }),
    undefined, "test/child-model");
  let live = emptyUsage();
  let configured = ["test/child-model", "test/child-model", "test/unused-model"];
  let factory: any;
  let contextCalls = 0;
  let renders = 0;
  let disposed = 0;
  let branchChanged: () => void = () => {};
  const ctx: any = {
    hasUI: true, mode: "tui", sessionManager: manager,
    model: { id: "main-model", provider: "test", reasoning: true, contextWindow: 272_000 },
    getContextUsage: () => { contextCalls++; return { percent: 13.9, tokens: 37_808, contextWindow: 272_000 }; },
    ui: { setFooter: (value: any) => { factory = value; } },
  };
  let thinking: ReturnType<Parameters<typeof installUsageFooter>[3]> = "high";
  const request = installUsageFooter(ctx, children, () => new Map([["test/child-model", live]]),
    () => thinking, () => configured);
  const component = factory({ requestRender: () => { renders++; } }, { fg: (_: string, text: string) => text }, {
    getGitBranch: () => "main", getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => new Map([["quota", "Quota: 80%"], ["omp", "OMP:orchestrator"]]),
    onBranchChange: (callback: () => void) => { branchChanged = callback; return () => { disposed++; }; },
  });
  return { component, manager, ctx, request, branchChanged, children,
    setLive: (value: ReturnType<typeof emptyUsage>) => { live = value; },
    setConfigured: (models: string[]) => { configured = models; },
    setThinking: (level: typeof thinking) => { thinking = level; },
    contextCalls: () => contextCalls, renders: () => renders, disposed: () => disposed };
}

test("one statistics row shows configured model totals including unused models, with only the context ratio at its end", () => {
  const h = footer();
  const lines = h.component.render(180);
  expect(lines).toHaveLength(3);
  expect(lines.filter((line: string) => line.includes("Σ"))).toHaveLength(1);
  expect(lines[0]).toContain("(main)");
  expect(lines[0]).toEndWith("main-model • high");
  expect(lines[1]).toBe("Σ3.2k · main-model 3.0k · child-model 160 · unused-model 0 · 13.9%/272.0k");
  expect(lines[1]).not.toMatch(/↑|↓|ctx|CTX|\$/);
  expect(lines[2]).toBe("OMP:orchestrator Quota: 80%");
});

test("current main model and thinking level update without a new session entry", () => {
  const h = footer();
  h.component.render(180);
  h.setThinking("xhigh");
  expect(h.component.render(180)[0]).toEndWith("main-model • xhigh");
  expect(h.contextCalls()).toBe(1);
  h.setThinking("off");
  expect(h.component.render(180)[0]).toEndWith("main-model • off");
  h.ctx.model = { ...h.ctx.model, id: "next-model" };
  expect(h.component.render(180)[0]).toEndWith("next-model • off");
  expect(h.component.render(180)[1]).toContain("next-model 0");
  expect(h.component.render(180)[1]).toContain("main-model 3.0k");
  expect(h.contextCalls()).toBe(2);
  h.ctx.model = { ...h.ctx.model, reasoning: false };
  expect(h.component.render(180)[0]).toEndWith("next-model");
  expect(h.component.render(180)[0]).not.toContain(" • off");
  h.ctx.model = undefined;
  expect(h.component.render(180)[0]).toEndWith("no-model");
});

test("streaming usage replaces its final snapshot, caches scans and redraws without overflowing narrow terminals", () => {
  const h = footer();
  h.component.render(180);
  h.setLive(addUsage(emptyUsage(), { output: 40 }));
  expect(h.component.render(180)[1]).toContain("child-model 200");
  expect(h.contextCalls()).toBe(1);
  h.children.record("child", addUsage(emptyUsage(), { input: 50, output: 80, cacheRead: 60, cacheWrite: 10 }),
    undefined, "test/child-model");
  h.setLive(emptyUsage());
  expect(h.component.render(180)[1]).toContain("child-model 200");
  h.manager.appendUsage("compaction", "test", "main-model", addUsage(emptyUsage(), { output: 10 }));
  expect(h.component.render(180)[1]).toContain("main-model 3.1k");
  expect(h.contextCalls()).toBe(2);
  for (const width of [0, 1, 5, 30, 80])
    for (const line of h.component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  h.request(); h.branchChanged();
  expect(h.renders()).toBe(2);
  h.component.dispose(); h.request();
  expect(h.disposed()).toBe(1);
  expect(h.renders()).toBe(2);
});

test("same-model agents merge, provider collisions stay distinct and historical model usage remains visible", () => {
  const h = footer();
  h.children.record("same-main", addUsage(emptyUsage(), { output: 50 }), undefined, "test/main-model");
  h.children.record("another-provider", addUsage(emptyUsage(), { output: 20 }), undefined, "other-provider/main-model");
  h.setConfigured(["test/unused-model"]);
  expect(h.component.render(180)[0]).toEndWith("test/main-model • high");
  const row = h.component.render(180)[1];
  expect(row).toContain("test/main-model 3.1k");
  expect(row).toContain("other-provider/main-model 20");
  expect(row).toContain("child-model 160");
  expect(row).toContain("unused-model 0");
  expect(row).toEndWith("13.9%/272.0k");
});

test("RPC mode keeps its native UI instead of installing a terminal footer", () => {
  installUsageFooter({ hasUI: true, mode: "rpc", ui: {} } as any, new ChildUsageLedger(), () => new Map(), () => "off");
});
