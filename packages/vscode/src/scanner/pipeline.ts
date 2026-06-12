// Hybrid extraction decision for one file: prefer the tree-sitter AST extractor,
// fall back to the heuristic extractor when no grammar is available or parsing
// throws. A successful AST run that finds nothing is authoritative — we do NOT
// fall back on an empty result, otherwise every AST-removed false positive would
// come straight back via the heuristics.

import { astExtract } from "./ast/extract";
import { astLangForExt, SPECS } from "./ast/specs";
import type { AstRuntime } from "./ast/runtime";
import { extractCodeUnits, extractFragments, type CodeScope } from "./extractor";
import { extname, type PrefilterResult } from "./prefilter";
import type { RawFragment } from "./shared";

export type ExtractPath = "standalone" | "ast" | "heuristic";

export interface ExtractOptions {
  minConfidence: number;
  scope: CodeScope;
  maxChars: number;
}

export function extractForFile(
  relPath: string,
  content: string,
  pre: PrefilterResult,
  opts: ExtractOptions,
  runtime: AstRuntime | undefined
): { fragments: RawFragment[]; path: ExtractPath } {
  // Standalone prompt files and prompt-shaped config stay whole-file (unchanged).
  if (pre.standalone || pre.configPrompt) {
    return {
      fragments: extractFragments(relPath, content, pre, opts.minConfidence),
      path: "standalone",
    };
  }
  if (!pre.suspect) {
    return { fragments: [], path: "heuristic" };
  }

  const langId = astLangForExt(extname(relPath));
  const handle = langId ? runtime?.parserFor(langId) : undefined;
  if (langId && handle) {
    try {
      const fragments = astExtract(content, handle, SPECS[langId], {
        minConfidence: opts.minConfidence,
        hasSdkImport: pre.hasSdkImport,
        scope: opts.scope,
        maxChars: opts.maxChars,
      });
      return { fragments, path: "ast" };
    } catch {
      // Parsing/extraction failed for this file — degrade to heuristics below.
    }
  }

  return {
    fragments: extractCodeUnits(relPath, content, pre, {
      minConfidence: opts.minConfidence,
      scope: opts.scope,
      maxChars: opts.maxChars,
    }),
    path: "heuristic",
  };
}
