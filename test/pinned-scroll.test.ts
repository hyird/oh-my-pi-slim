import { expect, test } from "bun:test";
import { scrollablePinnedCard } from "../extensions/omp/pinned-scroll.ts";

const mouse = (type: "wheel" | "click", y: number, wheelDelta = 0): any => ({
  type, button: "left", x: 2, y, screenX: 2, screenY: y,
  width: 40, height: 13, shift: false, alt: false, ctrl: false, wheelDelta,
});

test("expanded detail scrolls beneath task rows within 65% terminal height", () => {
  const state = { listTop: 0, detailTop: 0 };
  let renders = 0;
  const clicked: number[] = [];
  const list = { render: () => ["OMP", "task 1", "task 2"], invalidate() {},
    handleMouse(event: any) { if (event.type === "click") clicked.push(event.y); return { handled: true }; } };
  const detail = { render: () => Array.from({ length: 30 }, (_, i) => `detail ${i + 1}`), invalidate() {} };
  const card = scrollablePinnedCard(list, detail, 20, state, () => { renders++; }, (text) => text);
  expect(card.render(40)).toHaveLength(13);
  expect(card.render(40).slice(0, 3)).toEqual(["OMP", "task 1", "task 2"]);
  expect(card.render(40).at(-1)).toContain("1–9/30");
  expect(card.handleMouse?.(mouse("wheel", 5, 5))?.handled).toBe(true);
  expect(state.detailTop).toBe(5);
  expect(renders).toBe(1);
  expect(card.render(40).slice(0, 3)).toEqual(["OMP", "task 1", "task 2"]);
  expect(card.render(40)[3]).toBe("detail 6");
  card.handleMouse?.(mouse("click", 2));
  expect(clicked).toEqual([2]);
  card.handleMouse?.(mouse("wheel", 1, 100));
  expect(state.detailTop).toBe(21);
  expect(card.render(40).at(-1)).toContain("22–30/30");
});

test("a long task list scrolls separately while detail stays visible", () => {
  const state = { listTop: 0, detailTop: 0 };
  const list = { render: () => Array.from({ length: 30 }, (_, i) => `task ${i + 1}`), invalidate() {} };
  const detail = { render: () => Array.from({ length: 12 }, (_, i) => `detail ${i + 1}`), invalidate() {} };
  const card = scrollablePinnedCard(list, detail, 20, state, () => {}, (text) => text);
  expect(card.render(40)).toHaveLength(13);
  expect(card.render(40).join("\n")).toContain("detail 1");
  card.handleMouse?.(mouse("wheel", 1, 5));
  expect(state.listTop).toBe(5);
  expect(state.detailTop).toBe(0);
  const scrolled = card.render(40);
  expect(scrolled[0]).toBe("task 6");
  expect(scrolled.join("\n")).toContain("detail 1");
});

test("opening detail keeps the clicked row visible when the list viewport shrinks", () => {
  const state = { listTop: 0, detailTop: 0, focusedListRow: undefined as number | undefined };
  const list = { render: () => Array.from({ length: 30 }, (_, i) => `task ${i + 1}`), invalidate() {},
    handleMouse: () => ({ handled: true }) };
  const collapsed = scrollablePinnedCard(list, undefined, 20, state, () => {}, (text) => text);
  expect(collapsed.render(40)).toHaveLength(13);
  collapsed.handleMouse?.(mouse("click", 10));
  const detail = { render: () => Array.from({ length: 12 }, (_, i) => `detail ${i + 1}`), invalidate() {} };
  const expanded = scrollablePinnedCard(list, detail, 20, state, () => {}, (text) => text);
  expect(expanded.render(40).slice(0, 9)).toContain("task 11");
  expect(state.listTop).toBe(3);
  expect(state.focusedListRow).toBeUndefined();
});

test("short task lists retain their height and reset stale offsets", () => {
  const state = { listTop: 9, detailTop: 8 };
  const card = scrollablePinnedCard({ render: () => ["OMP", "task"], invalidate() {} }, undefined,
    10, state, () => {}, (text) => text);
  expect(card.render(40)).toEqual(["OMP", "task"]);
  expect(state).toEqual({ listTop: 0, detailTop: 0 });
});
