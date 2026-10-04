import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

test("Pi's jiti extension loader imports OMP from a non-project cwd", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-loader-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      additionalExtensionPaths: [path.resolve(import.meta.dir, "../extensions/omp/entry.ts")],
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
