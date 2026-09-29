import { expect, test } from "bun:test";
import { failureDetail } from "../extensions/omp/failure-detail.ts";

test("failure details include codes and bounded circular cause chains", () => {
  const outer = new Error("outer failure");
  const inner = new Error("disk failure");
  Object.defineProperty(outer, "code", { value: "EIO" });
  Object.defineProperty(outer, "cause", { value: inner });
  Object.defineProperty(inner, "cause", { value: outer });
  expect(failureDetail(outer)).toBe("EIO: outer failure <- disk failure");
  expect(failureDetail(new Error("x".repeat(900)))).toHaveLength(600);
});

test("non-Error failures are formatted safely", () => {
  expect(failureDetail({ message: "thrown object" })).toBe("thrown object");
  expect(failureDetail("thrown string")).toBe("thrown string");
  expect(failureDetail(undefined)).toBeUndefined();
});

test("failure details strip terminal controls and redact common credentials", () => {
  const detail = failureDetail(
    "\u001b[31mBearer private-token\u001b[0m api_key=private-key https://user:password@example.test/path",
  );
  expect(detail).toContain("Bearer [redacted]");
  expect(detail).toContain("api_key=[redacted]");
  expect(detail).toContain("https://[redacted]@example.test/path");
  expect(detail).not.toMatch(/[\u001b\x00-\x1f\x7f]/);
  expect(detail).not.toContain("private-token");
  expect(detail).not.toContain("private-key");
  expect(detail).not.toContain("user:password");
});
