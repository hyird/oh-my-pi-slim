import { expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

test("Pi's jiti extension loader imports OMP from a non-project cwd", async () => {
  const piEntry = path.resolve(
    import.meta.dir,
    "../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  );
  const { loadExtensions } = await import(
    pathToFileURL(path.resolve(path.dirname(piEntry), "core/extensions/loader.js")).href
  );
  const loaded = await loadExtensions(
    [path.resolve(import.meta.dir, "../extensions/omp/entry.ts")],
    path.resolve(import.meta.dir, "../node_modules"),
  );
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
});
