import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTestRuntime } from "./testWasm";

// Smoke test: if this fails, the wasm files moved or the API changed — every
// other AST test would fail confusingly, so this one runs the core path alone.
test("runtime: init + parse a trivial program for every grammar", async () => {
  const langs = [
    "python",
    "javascript",
    "typescript",
    "tsx",
    "java",
    "csharp",
  ] as const;
  const runtime = await loadTestRuntime(langs);
  assert.ok(runtime, "runtime should initialize from node_modules wasm");

  for (const id of langs) {
    const handle = runtime!.parserFor(id);
    assert.ok(handle, `grammar '${id}' should load`);
    const tree = handle!.parser.parse("x = 1");
    assert.ok(tree, `parse should return a tree for '${id}'`);
    assert.ok(tree!.rootNode.type.length > 0, `root node type for '${id}'`);
    tree!.delete();
  }
});
