import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverDcpTools, dcpRegistrationFailure, mergeRoleTools } from "../extensions/omp/dcp-tools.ts";

function fixture(name = "@davecodes/pi-dcp") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dcp-source-"));
  const entry = path.join(root, "index.ts");
  fs.writeFileSync(entry, "export default () => {};\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, pi: { extensions: ["./index.ts"] } }));
  return { root, entry, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function tool(name: string, sourceInfo: Record<string, unknown>, exposure = "direct") {
  return { name, sourceInfo, exposure } as any;
}
function api(tools: any[], active: string[]) {
  return { getAllTools: () => tools, getActiveTools: () => active } as any;
}

 test("discovers active tools using package identity and exact resource metadata, not tool names", () => {
  const pkg = fixture();
  try {
    const source = { path: pkg.entry, source: "npm:@davecodes/pi-dcp", scope: "user", origin: "package" };
    const snapshot = discoverDcpTools(api([
      tool("compress_v2", source),
      tool("prune_context", source),
      tool("compress", { ...source, path: "/not/a/real/source.ts" }),
    ], ["compress_v2", "prune_context", "compress"]));
    expect(snapshot.tools).toEqual(["compress_v2", "prune_context"]);
    expect(snapshot.providers).toEqual([{ path: fs.realpathSync(pkg.entry), tools: ["compress_v2", "prune_context"] }]);
    expect(mergeRoleTools(["read", "bash", "read"], snapshot.tools)).toEqual(["read", "bash", "compress_v2", "prune_context"]);
  } finally {
    pkg.cleanup();
  }
});

test("does not inherit inactive, hidden, unregistered, source-less, or unrelated lookalikes", () => {
  const pkg = fixture();
  const unrelated = fixture("another-package");
  try {
    const source = { path: pkg.entry, source: "manual", scope: "project", origin: "top-level" };
    const dcp = tool("renamed_tool", source);
    const snapshot = discoverDcpTools(api([
      dcp,
      tool("hidden_tool", source, "hidden"),
      tool("compress", { path: unrelated.entry, source: "npm:@davecodes/pi-dcp", scope: "user", origin: "package" }),
      tool("fake", { path: pkg.entry, source: "", scope: "user", origin: "package" }),
      tool("external", undefined as any),
    ], ["hidden_tool", "compress", "fake", "external"]));
    expect(snapshot.tools).toEqual([]);
  } finally {
    pkg.cleanup();
    unrelated.cleanup();
  }
});

test("manual package resources are eligible only when active", () => {
  const pkg = fixture();
  try {
    const source = { path: pkg.entry, source: "manual", scope: "temporary", origin: "top-level" };
    const inactive = discoverDcpTools(api([tool("manual_tool", source)], []));
    const active = discoverDcpTools(api([tool("manual_tool", source)], ["manual_tool"]));
    expect(inactive.tools).toEqual([]);
    expect(active.tools).toEqual(["manual_tool"]);
  } finally {
    pkg.cleanup();
  }
});

test("deduplicates providers and supports git-backed package resources", () => {
  const pkg = fixture();
  try {
    const source = { path: pkg.entry, source: "git:https://github.com/Davidcreador/pi-dcp", scope: "user", origin: "package" };
    const snapshot = discoverDcpTools(api([tool("first", source), tool("second", source)], ["first", "second"]));
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.tools).toEqual(["first", "second"]);
    expect(snapshot.signature).toContain("first");
  } finally {
    pkg.cleanup();
  }
});

test("rejects malformed names, built-in collisions, and unknown active exposures without trimming", () => {
  const pkg = fixture();
  try {
    const source = { path: pkg.entry, source: "npm:@davecodes/pi-dcp", scope: "user", origin: "package" };
    const names = ["context_pack", "bash", " edit ", "write", "read", "websearch", "tool_search", "mcp__foreign__run", "bad,name", "bad\tname", "bad\nname", "UPPER"];
    const candidates = names.map((name) => tool(name, source));
    candidates.push(tool("known_non_model_exposure", source, "codemode"), tool("unknown_exposure", source, "future-exposure"), tool("hidden", source, "hidden"));
    const snapshot = discoverDcpTools(api(candidates, [...names, "known_non_model_exposure", "unknown_exposure", "hidden"]));
    expect(snapshot.tools).toEqual(["context_pack"]);
  } finally {
    pkg.cleanup();
  }
});

test("accepts explicit model-only DCP tools and rejects malformed existing manifests", () => {
  const pkg = fixture();
  const malformed = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dcp-malformed-"));
  const entry = path.join(malformed, "index.ts");
  fs.writeFileSync(entry, "export default () => {};\\n");
  fs.writeFileSync(path.join(malformed, "package.json"), "{");
  try {
    const good = { path: pkg.entry, source: "npm:@davecodes/pi-dcp", scope: "user", origin: "package" };
    const bad = { ...good, path: entry };
    const snapshot = discoverDcpTools(api([
      tool("model_only_tool", good, "model-only"),
      tool("malformed_manifest_tool", bad),
    ], ["model_only_tool", "malformed_manifest_tool"]));
    expect(snapshot.tools).toEqual(["model_only_tool"]);
  } finally {
    pkg.cleanup();
    fs.rmSync(malformed, { recursive: true, force: true });
  }
});

test("missing discovery APIs fail closed", () => {
  expect(discoverDcpTools({} as any)).toEqual({ providers: [], tools: [], signature: "[]" });
});

test("child registration checks reject a late foreign same-name replacement", () => {
  const pkg = fixture();
  const foreign = fixture("other-provider");
  try {
    const expected = new Map([["context_pack", pkg.entry]]);
    let registrations = [tool("context_pack", { path: pkg.entry }, "direct")];
    const child = { getAllTools: () => registrations, getActiveTools: () => ["context_pack"] } as any;
    expect(dcpRegistrationFailure(child, expected)).toBeUndefined();
    registrations = [tool("context_pack", { path: foreign.entry }, "direct")];
    expect(dcpRegistrationFailure(child, expected)).toContain("provider registration mismatch");
    registrations = [tool("context_pack", { path: pkg.entry }, "direct"), tool("context_pack", { path: foreign.entry }, "direct")];
    expect(dcpRegistrationFailure(child, expected)).toContain("provider registration mismatch");
  } finally {
    pkg.cleanup();
    foreign.cleanup();
  }
});
