// Test-only helper: locate the WASM files inside node_modules so unit tests can
// load the real tree-sitter runtime under `node --test`. Tests run from the
// package root (npm sets cwd), so process.cwd() is stable. Not shipped (under
// src/, excluded by .vscodeignore) and only imported from *.test.ts.

import * as path from "node:path";
import { getSharedRuntime, type AstLangId, type AstRuntime } from "./runtime";

export function testWasmDir(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    "@vscode",
    "tree-sitter-wasm",
    "wasm"
  );
}

export function loadTestRuntime(
  langs: readonly AstLangId[]
): Promise<AstRuntime | undefined> {
  return getSharedRuntime(testWasmDir(), langs, () => {});
}
