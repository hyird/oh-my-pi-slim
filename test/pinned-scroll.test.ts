import { expect, test } from "bun:test";
import { scrollablePinnedCard } from "../extensions/omp/pinned-scroll.ts";

const mouse = (type: "wheel" | "click", y: number, wheelDelta = 0): any => ({
  type, button: "left", x: 2, y, screenX: 2, screenY: y,
  width: 40, height: 13, shift: false, alt: false, ctrl: false, wheelDelta,
});

test("expanded detail scrolls below its row while later tasks remain visible", () => {
  const state = { listTop: 0, detailTop: 0 };
  let renders = 0;
  const clicked: number[] = [];
  let range = "";
  const setRange = (label: string | undefined) => {
    const next = label ?? "";
    if (range === next) return false;
    range = next;
    return true;
  };
  const list = { render: () => ["OMP", `task 1${range}`, "task 2"], invalidate() {},
    handleMouse(event: any) { if (event.type === "click") clicked.push(event.y); return { handled: true }; } };
  const detail = { render: () => Array.from({ length: 30 }, (_, i) => `detail ${i + 1}`), invalidate() {} };
  const card = scrollablePinnedCard(list, detail, 2, 20, state, () => { renders++; }, (text) => text, setRange);
  expect(card.render(40)).toHaveLength(10);
  expect(card.render(40)[0]).toBe("OMP");
  expect(card.render(40)[1]).toContain("task 1");
  expect(card.render(40)[2]).toBe("detail 1");
  expect(card.render(40).at(-1)).toBe("task 2");
  expect(card.render(40)[1]).toContain("1–7/30");
  expect(card.render(40)[8]).toContain("detail 7");
  expect(card.handleMouse?.(mouse("wheel", 5, 5))?.handled).toBe(true);
  expect(state.detailTop).toBe(5);
  expect(renders).toBe(1);
  expect(card.render(40)[1]).toContain("6–12/30");
  expect(card.render(40)[2]).toBe("detail 6");
  expect(card.render(40).at(-1)).toBe("task 2");
  card.handleMouse?.(mouse("click", 9));
  expect(clicked).toEqual([2]);
  card.handleMouse?.(mouse("wheel", 1, 100));
  expect(state.detailTop).toBe(23);
  expect(card.render(40)[1]).toContain("24–30/30");
});

test("a long task list scrolls separately while detail stays visible", () => {
  const state = { listTop: 0, detailTop: 0 };
  const list = { render: () => Array.from({ length: 30 }, (_, i) => `task ${i + 1}`), invalidate() {} };
  const detail = { render: () => Array.from({ length: 12 }, (_, i) => `detail ${i + 1}`), invalidate() {} };
  const card = scrollablePinnedCard(list, detail, 6, 20, state, () => {}, (text) => text);
  expect(card.render(40)).toHaveLength(10);
  expect(card.render(40).join("\n")).toContain("detail 1");
  card.handleMouse?.(mouse("wheel", 1, 5));
  expect(state.listTop).toBe(5);
  expect(state.detailTop).toBe(0);
  const scrolled = card.render(40);
  expect(scrolled[0]).toBe("task 6");
  expect(scrolled.join("\n")).toContain("detail 1");
});

test("task rows scroll when a fixed card exceeds half the terminal", () => {
  const state = { listTop: 0, detailTop: 0 };
  const list = { render: () => ["OMP", ...Array.from({ length: 18 }, (_, i) => `task ${i + 1}`)], invalidate() {} };
  const card = scrollablePinnedCard(list, undefined, undefined, 20, state, () => {}, (text) => text);
  expect(card.render(40)).toHaveLength(10);
  expect(card.render(40).join("\n")).toContain("task 1");
  card.handleMouse?.(mouse("wheel", 3, 10));
  expect(state.listTop).toBe(10);
  expect(card.render(40)).toHaveLength(10);
  expect(card.render(40).join("\n")).toContain("task 18");
});

test("opening detail keeps the clicked row visible when the list viewport shrinks", () => {
  const state = { listTop: 0, detailTop: 0, focusedListRow: undefined as number | undefined };
  const list = { render: () => Array.from({ length: 30 }, (_, i) => `task ${i + 1}`), invalidate() {},
    handleMouse: () => ({ handled: true }) };
  const collapsed = scrollablePinnedCard(list, undefined, undefined, 20, state, () => {}, (text) => text);
  expect(collapsed.render(40)).toHaveLength(10);
  collapsed.handleMouse?.(mouse("click", 7));
  const detail = { render: () => Array.from({ length: 12 }, (_, i) => `detail ${i + 1}`), invalidate() {} };
  const expanded = scrollablePinnedCard(list, detail, 8, 20, state, () => {}, (text) => text);
  expect(expanded.render(40).slice(0, 9).some(line => line.includes("task 8"))).toBe(true);
  expect(state.listTop).toBe(3);
  expect(state.focusedListRow).toBeUndefined();
});

test("short task lists retain their height and reset stale offsets", () => {
  const state = { listTop: 9, detailTop: 8 };
  const card = scrollablePinnedCard({ render: () => ["OMP", "task"], invalidate() {} }, undefined, undefined,
    10, state, () => {}, (text) => text);
  expect(card.render(40)).toEqual(["OMP", "task"]);
  expect(state).toEqual({ listTop: 0, detailTop: 0 });
});

test("a very short terminal keeps the selected task row visible beside the detail", () => {
  const state = { listTop: 0, detailTop: 0, focusedListRow: 1 };
  const list = { render: () => ["OMP", "task 1", "task 2", "task 3"], invalidate() {} };
  const detail = { render: () => Array.from({ length: 10 }, (_, i) => `detail ${i + 1}`), invalidate() {} };
  const card = scrollablePinnedCard(list, detail, 2, 6, state, () => {}, (text) => text);
  expect(card.render(40)).toHaveLength(3);
  expect(card.render(40)).toContain("task 1");
});
