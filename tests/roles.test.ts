import { expect, test } from "bun:test";
import { ROLES } from "../extensions/omp/roles.ts";

test("orchestrator proactively dispatches useful parallel lanes", () => {
  const prompt = ROLES.orchestrator.prompt;
  expect(prompt).toContain("proactively look for useful independent investigation, implementation, testing, and review lanes");
  expect(prompt).toContain("When at least two lanes are independently useful, dispatch them together");
  expect(prompt).toContain("broad tasks will commonly justify 3–5 lanes");
  expect(prompt).toContain("Multiple children may use the same role");
  expect(prompt).toContain("advance any newly ready dependent work without waiting for unrelated slower tasks");
  expect(prompt).toContain("Avoid becoming the implementation bottleneck");
});

test("parallel delegation retains scope, ownership, sequencing, and adaptive safeguards", () => {
  const prompt = ROLES.orchestrator.prompt;
  expect(prompt).toContain("For isolated low-risk changes, direct work is acceptable");
  expect(prompt).toContain("Do not pad a batch to hit a target");
  expect(prompt).toContain("keep one writer per file and sequence genuine dependencies");
  expect(prompt).toContain("Adapt dispatch to cost, rate limits and provider errors");
  expect(prompt).toContain("avoid duplicate or low-value work");
});
