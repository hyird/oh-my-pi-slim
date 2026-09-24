import { expect, test } from "bun:test";
import { scrollablePinnedCard } from "../extensions/omp/pinned-scroll.ts";

const mouse = (type: "wheel" | "click", y: number, wheelDelta = 0): any => ({
  type, button: "left", x: 2, y, screenX: 2, screenY: y,
  width: 40, height: 13, shift: false, alt: false, ctrl: false, wheelDelta,
});

test("fixed card uses at most 65% of terminal rows and scrolls with the wheel", () => {
  const state = { top: 0 };
  let renders = 0;
  const lines = Array.from({ length: 30 }, (_, index) => `row ${index + 1}`);
  const clicked: number[] = [];
  const card = scrollablePinnedCard({
    render: () => lines,
    invalidate() {},
    handleMouse(event) { if (event.type === "click") clicked.push(event.y); return { handled: true }; },
  }, 20, state, () => { renders++; }, (text) => text);
  expect(card.render(40)).toHaveLength(13);
  expect(card.render(40)[0]).toBe("row 1");
  expect(card.render(40).at(-1)).toContain("1–12/30");
  expect(card.handleMouse?.(mouse("wheel", 4, 5))?.handled).toBe(true);
  expect(state.top).toBe(5);
  expect(renders).toBe(1);
  expect(card.render(40)[0]).toBe("row 6");
  card.handleMouse?.(mouse("click", 2));
  expect(clicked).toEqual([7]);
  card.handleMouse?.(mouse("wheel", 4, 100));
  expect(state.top).toBe(18);
  expect(card.render(40).at(-1)).toContain("19–30/30");
  card.handleMouse?.(mouse("wheel", 4, -100));
  expect(state.top).toBe(0);
});

test("short cards retain their full layout and reset stale scroll position", () => {
  const state = { top: 9 };
  const card = scrollablePinnedCard({ render: () => ["OMP", "task"], invalidate() {} },
    10, state, () => {}, (text) => text);
  expect(card.render(40)).toEqual(["OMP", "task"]);
  expect(state.top).toBe(0);
});
