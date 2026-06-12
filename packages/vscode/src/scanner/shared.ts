// Path-agnostic scanner primitives shared by the heuristic extractor
// (extractor.ts) and the tree-sitter AST extractor (ast/). Keeping these in one
// place means both paths emit identical RawFragment shapes, use the same
// natural-language gate and confidence weights, and build code units (whole-file
// / region) the same way.

import type { ArtifactType } from "../detector/types";

export interface RawFragment {
  char_start: number; // document offset of the artifact text start
  char_end: number;
  line_start: number; // 0-based
  line_end: number;
  text: string; // the prompt text
  confidence: number; // 0–1
  artifactType: ArtifactType;
}

// Languages with bespoke extraction. "js" covers JavaScript + TypeScript (+ JSX).
export type Lang = "python" | "js" | "java" | "csharp";

export const MIN_INNER_LEN = 16;
export const MAX_FRAGMENTS_PER_FILE = 200;

// Confidence weights — one source of truth for both extraction paths, so an AST
// hit and the heuristic hit for the same construct score identically.
export const CONF = {
  /** `"content": "<string>"` in a message array. */
  contentKey: 0.85,
  /** `"role": "system"` etc. immediately before the string. */
  roleKey: 0.8,
  /** prompt-named binding in a file that imports an LLM SDK. */
  promptName: 0.8,
  /** string on the same line as a known LLM call site. */
  callSiteSameLine: 0.9,
  /** string within a few lines of a known call site. */
  callSiteNear: 0.8,
  /** AST: a `[{role, content}]` message array as one unit. */
  messageArray: 0.9,
  /** AST: direct string argument of a known call site / prompt annotation. */
  promptArg: 0.9,
  /** telltale "you are …" content. */
  youAre: 0.7,
} as const;

// ── shared prompt vocabulary (one source of truth for both paths) ────────────

// Names that mark a binding / object key as prompt-ish.
export const PROMPT_WORD = "prompt|template|system|instruction|messages?|msg|sys";
export const PROMPT_WORD_RE = new RegExp(`(?:${PROMPT_WORD})`, "i");

// Callee-text fragments that identify a known LLM call. The AST path matches
// these against a call node's function-expression text; the heuristic path
// appends "\\s*\\(" to each to find call sites in raw source. Add a new SDK in
// ONE place and both extractors pick it up.
export const LLM_CALLEES: readonly string[] = [
  "\\.chat\\.completions\\.create",
  "\\.messages\\.create",
  "\\.completions\\.create",
  "\\.responses\\.create",
  "ChatCompletion\\.create",
  "litellm\\.a?completion",
  "(?:Chat)?PromptTemplate",
  "\\.from_template",
  "\\.from_messages",
  "(?:System|Human|User|AI)Message(?:PromptTemplate)?",
  "InvokePromptAsync",
  "CreateFunctionFromPrompt",
  "CreateFromPrompt",
  "\\.Add(?:System|User|Assistant)Message",
  "(?:System|User|Assistant)ChatMessage",
  "ChatRequest(?:System|User|Assistant)Message",
];

// AST path: a string that is the direct argument of one of these calls is a
// prompt. The fluent builder methods (.prompt/.system/.user) are trusted here
// because the AST already knows the string is that call's argument; in raw
// source those names are too generic, so the heuristic anchors on a string arg
// instead (see extractor.ts).
export const KNOWN_CALL_RE = new RegExp(
  `(?:${[...LLM_CALLEES, "\\.(?:prompt|system|user)\\b"].join("|")})`
);

// ── offset → line ────────────────────────────────────────────────────────────

export function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

export function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// ── natural-language gate ────────────────────────────────────────────────────

export function looksLikeNaturalLanguage(s: string): boolean {
  const t = s.trim();
  if (t.length < MIN_INNER_LEN) return false;
  if (!/\s/.test(t)) return false; // identifiers / paths / single tokens
  if (!/[A-Za-z]/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[\w./:@+-]+$/.test(t)) return false; // path/url/ident-only
  return true;
}

// ── code-unit construction (shared by heuristic + AST grouping) ──────────────

export function indentOf(lines: string[], ln: number): number {
  const s = lines[ln] ?? "";
  return s.length - s.trimStart().length;
}

export function maxConfidence(hits: RawFragment[]): number {
  return hits.reduce((m, h) => Math.max(m, h.confidence), 0);
}

export function lineEndOffset(
  content: string,
  starts: number[],
  line: number
): number {
  return line + 1 < starts.length ? starts[line + 1] - 1 : content.length;
}

export function unit(
  content: string,
  starts: number[],
  cs: number,
  ce: number,
  hits: RawFragment[]
): RawFragment {
  const start = Math.max(0, Math.min(cs, content.length));
  const end = Math.max(start, Math.min(ce, content.length));
  return {
    char_start: start,
    char_end: end,
    line_start: lineOf(starts, start),
    line_end: lineOf(starts, Math.max(start, end - 1)),
    text: content.slice(start, end),
    confidence: maxConfidence(hits),
    artifactType: "embedded_prompt",
  };
}

export function regionUnit(
  content: string,
  starts: number[],
  hits: RawFragment[],
  contextLines: number,
  maxChars: number
): RawFragment {
  const firstLine = Math.max(0, hits[0].line_start - contextLines);
  const lastLine = Math.min(
    starts.length - 1,
    hits[hits.length - 1].line_end + contextLines
  );
  const cs = starts[firstLine];
  let ce = lineEndOffset(content, starts, lastLine);
  if (ce - cs > maxChars) {
    ce = cs + maxChars;
  }
  return unit(content, starts, cs, ce, hits);
}

export function wholeFileUnit(
  content: string,
  starts: number[],
  lines: string[],
  lang: Lang,
  hits: RawFragment[],
  maxChars: number,
  stripHeader: boolean
): RawFragment {
  let start = 0;
  if (stripHeader && hits.length > 0) {
    // Never strip past the first prompt (in case the prompt IS the top docstring).
    start = Math.min(headerEndOffset(content, starts, lines, lang), hits[0].char_start);
  }
  if (content.length - start <= maxChars) {
    return unit(content, starts, start, content.length, hits);
  }
  return regionUnit(content, starts, hits, 3, maxChars);
}

// Offset where real code begins — skips a shebang plus a leading run of comments
// and a single module docstring, so a file-header comment is not sent to the LLM
// (it would bias the analysis). Python uses `#` / `"""`; every other language
// here uses `//` and `/* */`.
export function headerEndOffset(
  content: string,
  starts: number[],
  lines: string[],
  lang: Lang
): number {
  let ln = (lines[0] ?? "").startsWith("#!") ? 1 : 0;
  while (ln < lines.length) {
    const line = lines[ln] ?? "";
    const t = line.trim();
    if (t === "") {
      ln++;
      continue;
    }
    if (lang === "python") {
      if (t.startsWith("#")) {
        ln++;
        continue;
      }
      const m = /^(?:[rbuf]{0,2})("""|''')/i.exec(t);
      if (m) {
        const quote = m[1];
        const afterOpen = starts[ln] + line.indexOf(quote) + 3;
        const close = content.indexOf(quote, afterOpen);
        if (close === -1) {
          break;
        }
        ln = lineOf(starts, close + 3) + 1;
        continue;
      }
      break;
    }
    if (t.startsWith("//")) {
      ln++;
      continue;
    }
    if (t.startsWith("/*")) {
      const close = content.indexOf("*/", starts[ln]);
      if (close === -1) {
        break;
      }
      ln = lineOf(starts, close + 2) + 1;
      continue;
    }
    break;
  }
  return ln < starts.length ? starts[ln] : content.length;
}
