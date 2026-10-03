import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installUsageFooter } from "../extensions/omp/footer.ts";
import { ChildUsageLedger, addUsage, emptyUsage } from "../extensions/omp/usage.ts";

function footer() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "assistant", provider: "test", model: "model", api: "openai-responses",
    content: [], timestamp: 1, stopReason: "stop",
    usage: addUsage(emptyUsage(), { input: 1000, output: 20, cacheRead: 2000, cacheWrite: 30 }) });
  const children = new ChildUsageLedger();
  children.record("child", addUsage(emptyUsage(), { input: 50, output: 40, cacheRead: 60, cacheWrite: 10 }));
  let live = emptyUsage();
  let factory: any;
  let contextCalls = 0;
  let renders = 0;
  let disposed = 0;
  let branchChanged: () => void = () => {};
  const ctx: any = {
    hasUI: true, mode: "tui", sessionManager: manager,
    model: { id: "main-model", provider: "test", reasoning: true, contextWindow: 200_000 },
    getContextUsage: () => { contextCalls++; return { percent: 25, tokens: 50_000, contextWindow: 200_000 }; },
    ui: { setFooter: (value: any) => { factory = value; } },
  };
  const request = installUsageFooter(ctx, { getThinkingLevel: () => "high" } as any, children, () => live);
  const component = factory({ requestRender: () => { renders++; } }, { fg: (_: string, text: string) => text }, {
    getGitBranch: () => "main", getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => new Map([["quota", "Quota: 80%"], ["omp", "OMP:orchestrator"]]),
    onBranchChange: (callback: () => void) => { branchChanged = callback; return () => { disposed++; }; },
  });
  return { component, manager, ctx, request, branchChanged, children,
    setLive: (value: ReturnType<typeof emptyUsage>) => { live = value; },
    contextCalls: () => contextCalls, renders: () => renders, disposed: () => disposed };
}

test("one replacement statistics row combines parent and children and retains context, model and statuses", () => {
  const h = footer();
  const lines = h.component.render(180);
  expect(lines).toHaveLength(3);
  expect(lines.filter((line: string) => line.includes("↑"))).toHaveLength(1);
  expect(lines[0]).toContain("(main)");
  expect(lines[1]).toContain("Σ3.2k ↑1.1k ↓60 R2.1k W40");
  expect(lines[1]).toContain("ctx 25.0%/200.0k");
  expect(lines[1]).toContain("(test) main-model • high");
  expect(lines[2]).toBe("OMP:orchestrator Quota: 80%");
});

test("streaming usage replaces its final snapshot, caches scans and redraws without overflowing narrow terminals", () => {
  const h = footer();
  h.component.render(180);
  h.setLive(addUsage(emptyUsage(), { output: 40 }));
  expect(h.component.render(180)[1]).toContain("↓100");
  expect(h.contextCalls()).toBe(1);
  h.children.record("child", addUsage(emptyUsage(), { input: 50, output: 80, cacheRead: 60, cacheWrite: 10 }));
  h.setLive(emptyUsage());
  expect(h.component.render(180)[1]).toContain("↓100");
  h.manager.appendUsage("compaction", "test", "model", addUsage(emptyUsage(), { output: 10 }));
  expect(h.component.render(180)[1]).toContain("↓110");
  expect(h.contextCalls()).toBe(2);
  for (const width of [0, 1, 5, 30, 80])
    for (const line of h.component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  h.request(); h.branchChanged();
  expect(h.renders()).toBe(2);
  h.component.dispose(); h.request();
  expect(h.disposed()).toBe(1);
  expect(h.renders()).toBe(2);
});

test("RPC mode keeps its native UI instead of installing a terminal footer", () => {
  installUsageFooter({ hasUI: true, mode: "rpc", ui: {} } as any, {} as any, new ChildUsageLedger(), emptyUsage);
});
