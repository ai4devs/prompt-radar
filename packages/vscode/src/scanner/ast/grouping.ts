// Group AST string hits into code units for codeScope "auto"/"file", reusing the
// shared unit builders. Pure (offsets only, no tree-sitter Node), so it is
// unit-testable on its own. Each hit carries the document span of its enclosing
// function/method/class (or -1 for module-level), resolved in extract.ts.

import type { CodeScope } from "../extractor";
import {
  type Lang,
  lineStarts,
  type RawFragment,
  regionUnit,
  unit,
  wholeFileUnit,
} from "../shared";

export interface UnitHit {
  frag: RawFragment;
  unitStart: number; // enclosing unit node start offset, or -1 if module-level
  unitEnd: number;
}

export function groupAstHits(
  content: string,
  lang: Lang,
  hits: UnitHit[],
  scope: CodeScope,
  maxChars: number
): RawFragment[] {
  const frags = hits.map((h) => h.frag);
  if (frags.length === 0 || scope === "fragments") {
    return frags;
  }

  const starts = lineStarts(content);
  const lines = content.split("\n");

  if (scope === "file") {
    return [wholeFileUnit(content, starts, lines, lang, frags, maxChars, false)];
  }

  // auto: one unit per enclosing function/method/class; module-level hits share
  // the bucket keyed -1.
  const groups = new Map<number, UnitHit[]>();
  for (const h of hits) {
    const arr = groups.get(h.unitStart) ?? [];
    arr.push(h);
    groups.set(h.unitStart, arr);
  }
  const entries = [...groups.entries()];

  if (entries.length === 1) {
    const [key, gh] = entries[0];
    const gfrags = gh.map((h) => h.frag);
    if (key >= 0) {
      return [unitFor(content, starts, gh, gfrags, maxChars)];
    }
    // A single module-level prompt → whole file minus the leading header/docstring.
    return [wholeFileUnit(content, starts, lines, lang, gfrags, maxChars, true)];
  }

  const out = entries.map(([key, gh]) => {
    const gfrags = gh.map((h) => h.frag);
    return key >= 0
      ? unitFor(content, starts, gh, gfrags, maxChars)
      : regionUnit(content, starts, gfrags, 2, maxChars);
  });
  out.sort((a, b) => a.char_start - b.char_start);
  return out;
}

// Span the enclosing unit, falling back to a region when the unit is huge.
function unitFor(
  content: string,
  starts: number[],
  gh: UnitHit[],
  gfrags: RawFragment[],
  maxChars: number
): RawFragment {
  const start = gh[0].unitStart;
  const end = gh[0].unitEnd;
  if (end - start > maxChars) {
    return regionUnit(content, starts, gfrags, 3, maxChars);
  }
  return unit(content, starts, start, end, gfrags);
}
