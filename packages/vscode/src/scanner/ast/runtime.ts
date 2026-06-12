// Tree-sitter runtime: loads the WASM parser + grammars and hands back per-
// language parser handles. This module is pure w.r.t. vscode (it takes a
// directory path, never touches the workspace API) so it is unit-testable under
// `node --test` — the boundary that resolves the real dist/wasm path lives in
// Scanner.ts.
//
// Everything is best-effort: if the runtime or a grammar fails to load, the
// scanner silently falls back to the heuristic extractor (see pipeline.ts).

import * as path from "node:path";
import { Language, Parser } from "@vscode/tree-sitter-wasm";

export type AstLangId =
  | "python"
  | "javascript"
  | "typescript"
  | "tsx"
  | "java"
  | "csharp";

export const GRAMMAR_FILE: Record<AstLangId, string> = {
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c-sharp.wasm",
};

export const RUNTIME_WASM = "tree-sitter.wasm";

export interface ParserHandle {
  parser: Parser;
  language: Language;
}

export interface AstRuntime {
  /** A ready parser for this language, or undefined if its grammar didn't load. */
  parserFor(id: AstLangId): ParserHandle | undefined;
  dispose(): void;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One runtime per process. Parser.init() is global emscripten state, so it must
// run exactly once; grammars are loaded lazily and cached (null = tried+failed,
// so we don't retry a broken grammar on every scan).
class SharedRuntime implements AstRuntime {
  private readonly handles = new Map<AstLangId, ParserHandle | null>();

  constructor(
    private readonly wasmDir: string,
    private readonly log: (m: string) => void
  ) {}

  async ensure(langs: readonly AstLangId[]): Promise<void> {
    for (const id of langs) {
      if (this.handles.has(id)) {
        continue;
      }
      try {
        const language = await Language.load(
          path.join(this.wasmDir, GRAMMAR_FILE[id])
        );
        const parser = new Parser();
        parser.setLanguage(language);
        this.handles.set(id, { parser, language });
      } catch (err) {
        this.handles.set(id, null);
        this.log(`tree-sitter: grammar '${id}' failed to load: ${msg(err)}`);
      }
    }
  }

  parserFor(id: AstLangId): ParserHandle | undefined {
    return this.handles.get(id) ?? undefined;
  }

  dispose(): void {
    for (const handle of this.handles.values()) {
      handle?.parser.delete();
    }
    this.handles.clear();
  }
}

let parserInit: Promise<void> | undefined;
let runtime: SharedRuntime | undefined;

/**
 * Resolve the process-wide AST runtime with grammars for `langs` loaded.
 * Returns undefined if the WASM runtime itself can't initialize — callers then
 * use the heuristic extractor. Safe to call once per scan; cheap after the first.
 */
export async function getSharedRuntime(
  wasmDir: string,
  langs: readonly AstLangId[],
  log: (m: string) => void
): Promise<AstRuntime | undefined> {
  try {
    if (!parserInit) {
      parserInit = Parser.init({
        locateFile: () => path.join(wasmDir, RUNTIME_WASM),
      });
    }
    await parserInit;
  } catch (err) {
    parserInit = undefined; // allow a later retry (e.g. a fixed install)
    log(
      `tree-sitter: runtime unavailable, using heuristic extractor: ${msg(err)}`
    );
    return undefined;
  }
  if (!runtime) {
    runtime = new SharedRuntime(wasmDir, log);
  }
  await runtime.ensure(langs);
  return runtime;
}

/** Dispose the shared runtime (wired to extension deactivate()). */
export function disposeSharedRuntime(): void {
  runtime?.dispose();
  runtime = undefined;
}
