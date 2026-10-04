import { expect, test } from "bun:test";
import { waitFor } from "../extensions/omp/wait-for.ts";

test("readiness returns immediately for an available resource", async () => {
  expect(await waitFor(() => true, { timeoutMs: 0 })).toBe(true);
});

test("readiness retries discovery until the resource appears", async () => {
  let attempts = 0;
  expect(await waitFor(() => ++attempts === 3, { timeoutMs: 500, intervalMs: 1 })).toBe(true);
  expect(attempts).toBe(3);
});

test("an unavailable resource has a bounded readiness wait", async () => {
  let attempts = 0;
  expect(await waitFor(() => { attempts++; return false; }, { timeoutMs: 20, intervalMs: 2 })).toBe(false);
  expect(attempts).toBeGreaterThan(1);
});

test("an already cancelled wait does not inspect or accept a ready resource", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before discovery"));
  let inspected = false;
  await expect(waitFor(() => { inspected = true; return true; }, {
    signal: controller.signal, timeoutMs: 1000,
  })).rejects.toThrow("cancelled before discovery");
  expect(inspected).toBe(false);
});

for (const source of ["caller", "session"] as const) {
  test(`${source} cancellation interrupts a pending wait and stops polling`, async () => {
    const caller = new AbortController();
    const session = new AbortController();
    let attempts = 0;
    const promise = waitFor(() => { attempts++; return false; }, {
      signal: AbortSignal.any([caller.signal, session.signal]),
      timeoutMs: 10_000, intervalMs: 1000,
    });
    (source === "caller" ? caller : session).abort();
    await expect(promise).rejects.toThrow();
    expect(attempts).toBe(1);
  });
}

test("readiness validation failures propagate without retrying", async () => {
  let attempts = 0;
  await expect(waitFor(() => { attempts++; throw new Error("owner mismatch"); }, {
    timeoutMs: 1000,
  })).rejects.toThrow("owner mismatch");
  expect(attempts).toBe(1);
});

test("readiness rejects invalid timing options", async () => {
  for (const timeoutMs of [-1, Infinity, NaN]) {
    await expect(waitFor(() => false, { timeoutMs })).rejects.toThrow("Invalid readiness");
  }
  for (const intervalMs of [0, -1, Infinity, NaN]) {
    await expect(waitFor(() => false, { timeoutMs: 1, intervalMs })).rejects.toThrow("Invalid readiness");
  }
});
