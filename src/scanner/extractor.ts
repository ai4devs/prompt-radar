// Tier 2 — heuristic fragment extraction (precision-first, v0.1.1).
//
// TODO(v0.2): replace with a tree-sitter AST extractor (spec §6.2). For v0.1 we
// avoid native/WASM parser deps to keep the .vsix cross-platform (see NOTES.md).
// Extraction only emits a fragment when there is a real signal: a string at a
// specific LLM call site, a message-array content/role key, a prompt-named
// assignment in a file that imports an LLM SDK, or telltale "You are …" content.
// Generic directory names and generic method calls are deliberately NOT signals.

import type { ArtifactType } from "../detector/types";
import { extname, type PrefilterResult } from "./prefilter";

export interface RawFragment {
  char_start: number; // document offset of the artifact text start
  char_end: number;
  line_start: number; // 0-based
  line_end: number;
  text: string; // the prompt text (string contents, no quotes)
  confidence: number; // 0–1
  artifactType: ArtifactType;
}

type Lang = "python" | "js";

const DEFAULT_MIN_CONFIDENCE = 0.6;
const MIN_INNER_LEN = 16;
const MAX_FRAGMENTS_PER_FILE = 200;
const CALL_ARG_WINDOW_LINES = 8; // a string is "at" a call site if within N lines after it

const CODE_EXTS = new Set([
  ".py",
  ".pyi",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

interface StringTok {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  inner: string;
}

export function languageForPath(relPath: string): Lang {
  const ext = extname(relPath);
  return ext === ".py" || ext === ".pyi" ? "python" : "js";
}

// ── offset → line ────────────────────────────────────────────────────────────

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
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

function isIdentChar(c: string | undefined): boolean {
  return !!c && /[A-Za-z0-9_]/.test(c);
}

// ── specific LLM call sites ──────────────────────────────────────────────────

const CALL_SITE_PATTERNS: RegExp[] = [
  /\.chat\.completions\.create\s*\(/g,
  /\.messages\.create\s*\(/g,
  /\.completions\.create\s*\(/g,
  /\.responses\.create\s*\(/g,
  /\bChatCompletion\.create\s*\(/g,
  /\blitellm\.a?completion\s*\(/g,
  /\b(Chat)?PromptTemplate\s*\(/g,
  /\.from_template\s*\(/g,
  /\.from_messages\s*\(/g,
  /\b(System|Human|AI)Message(PromptTemplate)?\s*\(/g,
];

function findCallSiteLines(content: string, starts: number[]): Set<number> {
  const lines = new Set<number>();
  for (const re of CALL_SITE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      lines.add(lineOf(starts, m.index));
      if (m.index === re.lastIndex) {
        re.lastIndex++;
      }
    }
  }
  return lines;
}

// ── string tokenizers ────────────────────────────────────────────────────────

function scanStrings(content: string, lang: Lang): StringTok[] {
  const toks: StringTok[] = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    const ch = content[i];
    if (lang === "python" && ch === "#") {
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (lang === "js" && ch === "/" && content[i + 1] === "/") {
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (lang === "js" && ch === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    const tok =
      lang === "python" ? readPyString(content, i) : readJsString(content, i);
    if (tok) {
      toks.push(tok);
      i = tok.end;
      continue;
    }
    i++;
  }
  return toks;
}

function readPyString(content: string, start: number): StringTok | undefined {
  let j = start;
  let prefixLen = 0;
  while (prefixLen < 2 && /[frbuFRBU]/.test(content[j] ?? "")) {
    j++;
    prefixLen++;
  }
  const quote = content[j];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  if (prefixLen > 0 && isIdentChar(content[start - 1])) {
    return undefined;
  }
  const triple = content[j + 1] === quote && content[j + 2] === quote;
  const innerStart = j + (triple ? 3 : 1);
  let k = innerStart;
  while (k < content.length) {
    const c = content[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (triple) {
      if (c === quote && content[k + 1] === quote && content[k + 2] === quote) {
        break;
      }
    } else if (c === quote || c === "\n") {
      break;
    }
    k++;
  }
  const innerEnd = k;
  const end =
    triple
      ? Math.min(content.length, k + 3)
      : content[k] === quote
        ? k + 1
        : k;
  return { start, end, innerStart, innerEnd, inner: content.slice(innerStart, innerEnd) };
}

function readJsString(content: string, start: number): StringTok | undefined {
  const quote = content[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return undefined;
  }
  const innerStart = start + 1;
  let k = innerStart;
  while (k < content.length) {
    const c = content[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === quote) {
      break;
    }
    if (c === "\n" && quote !== "`") {
      break;
    }
    k++;
  }
  const innerEnd = k;
  const end = content[k] === quote ? k + 1 : k;
  return { start, end, innerStart, innerEnd, inner: content.slice(innerStart, innerEnd) };
}

// ── natural-language gate ────────────────────────────────────────────────────

function looksLikeNaturalLanguage(s: string): boolean {
  const t = s.trim();
  if (t.length < MIN_INNER_LEN) return false;
  if (!/\s/.test(t)) return false; // identifiers / paths / single tokens
  if (!/[A-Za-z]/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[\w./:@+-]+$/.test(t)) return false; // path/url/ident-only
  return true;
}

// ── confidence ───────────────────────────────────────────────────────────────

function confidenceFor(
  content: string,
  tok: StringTok,
  tokLine: number,
  callLines: Set<number>,
  hasSdkImport: boolean
): number {
  const before = content.slice(Math.max(0, tok.start - 48), tok.start);
  let conf = 0;

  // message-array content / role key immediately before the string
  if (/["']?content["']?\s*:\s*$/.test(before)) {
    conf = Math.max(conf, 0.85);
  }
  if (/["']?(system|user|assistant|developer)["']?\s*:\s*$/.test(before)) {
    conf = Math.max(conf, 0.8);
  }

  // prompt-named assignment — only trusted in a file that imports an LLM SDK.
  // Trailing `\(?` allows parenthesized / implicitly-concatenated assignments
  // like `system = (\n  "You are…"`.
  if (
    hasSdkImport &&
    /\b\w*(prompt|template|system|instruction|messages?|msg|sys)\w*\s*(:\s*str)?\s*=\s*\(?\s*$/i.test(
      before
    )
  ) {
    conf = Math.max(conf, 0.8);
  }

  // directional proximity to a specific LLM call site (call on/just-before line)
  for (let l = tokLine; l >= tokLine - CALL_ARG_WINDOW_LINES && l >= 0; l--) {
    if (callLines.has(l)) {
      conf = Math.max(conf, l === tokLine ? 0.9 : 0.8);
      break;
    }
  }

  // strong telltale content signal (independent of imports). No leading \b so it
  // still fires when glued to an escape (e.g. "\nYou are"); no article required.
  if (/you are\b/i.test(tok.inner)) {
    conf = Math.max(conf, 0.7);
  }

  return conf;
}

// ── public API ───────────────────────────────────────────────────────────────

export function extractFragments(
  relPath: string,
  content: string,
  pre: PrefilterResult,
  minConfidence: number = DEFAULT_MIN_CONFIDENCE
): RawFragment[] {
  const starts = lineStarts(content);

  // Standalone prompt files and prompt-shaped config (e.g. an agent YAML with a
  // messages array) are analyzed as a single whole-file unit — the detector
  // reads the whole template / message array as one prompt.
  if (pre.standalone || pre.configPrompt) {
    if (content.trim().length === 0) {
      return [];
    }
    return [
      {
        char_start: 0,
        char_end: content.length,
        line_start: 0,
        line_end: lineOf(starts, Math.max(0, content.length - 1)),
        text: content,
        confidence: 0.9,
        artifactType: "prompt_template",
      },
    ];
  }

  const ext = extname(relPath);

  if (!pre.suspect || !CODE_EXTS.has(ext)) {
    return [];
  }

  const lang = languageForPath(relPath);
  const strings = scanStrings(content, lang);
  const callLines = findCallSiteLines(content, starts);

  const out: RawFragment[] = [];
  for (const tok of strings) {
    if (!looksLikeNaturalLanguage(tok.inner)) {
      continue;
    }
    const tokLine = lineOf(starts, tok.innerStart);
    const confidence = confidenceFor(content, tok, tokLine, callLines, pre.hasSdkImport);
    if (confidence < minConfidence) {
      continue;
    }
    out.push({
      char_start: tok.innerStart,
      char_end: tok.innerEnd,
      line_start: tokLine,
      line_end: lineOf(starts, Math.max(tok.innerStart, tok.innerEnd - 1)),
      text: tok.inner,
      confidence,
      artifactType: "embedded_prompt",
    });
    if (out.length >= MAX_FRAGMENTS_PER_FILE) {
      break;
    }
  }

  out.sort((a, b) => a.char_start - b.char_start);
  return out;
}

// ── code-unit extraction (auto / file / fragments) ───────────────────────────
//
// For source files we send a coherent UNIT to the detector (which extracts the
// prompt itself) instead of one fragment per string:
//   - fragments: one fragment per detected string (granular; legacy behavior)
//   - file:      one whole-file fragment
//   - auto:      one fragment per enclosing function/block when a file has prompts
//                in several functions; otherwise the whole file (best context for a
//                single-prompt file).

export type CodeScope = "auto" | "file" | "fragments";

const SITE_GAP_LINES = 6;

export function extractCodeUnits(
  relPath: string,
  content: string,
  pre: PrefilterResult,
  opts: { minConfidence: number; scope: CodeScope; maxChars: number }
): RawFragment[] {
  const hits = extractFragments(relPath, content, pre, opts.minConfidence);
  if (hits.length === 0 || opts.scope === "fragments") {
    return hits;
  }

  const starts = lineStarts(content);
  const lines = content.split("\n");
  const lang = languageForPath(relPath);

  if (opts.scope === "file") {
    // Explicit whole-file mode: keep the file intact (header included).
    return [wholeFileUnit(content, starts, lines, lang, hits, opts.maxChars, false)];
  }

  // auto
  const groups =
    lang === "python" ? groupByPythonFunction(lines, hits) : groupByGap(hits);

  if (groups.length === 1) {
    const g = groups[0];
    // A single prompt inside a function → that function's block, so a module
    // docstring / file-header comment is NOT sent to the LLM (it would bias the
    // analysis). A module-level prompt (no enclosing function) → whole file with
    // the leading comment/docstring stripped.
    return [
      g.header >= 0
        ? pythonBlockUnit(content, starts, lines, g.hits, g.header, opts.maxChars)
        : wholeFileUnit(content, starts, lines, lang, hits, opts.maxChars, true),
    ];
  }
  return groups.map((g) =>
    g.header >= 0
      ? pythonBlockUnit(content, starts, lines, g.hits, g.header, opts.maxChars)
      : regionUnit(content, starts, g.hits, 2, opts.maxChars)
  );
}

interface HitGroup {
  header: number; // enclosing def/class header line, or -1
  hits: RawFragment[];
}

function indentOf(lines: string[], ln: number): number {
  const s = lines[ln] ?? "";
  return s.length - s.trimStart().length;
}

function isPyHeader(lines: string[], ln: number): boolean {
  return /^(async\s+def|def|class)\b/.test((lines[ln] ?? "").trim());
}

function enclosingPyHeader(lines: string[], hitLine: number): number {
  const hitIndent = indentOf(lines, hitLine);
  for (let ln = hitLine; ln >= 0; ln--) {
    if ((lines[ln] ?? "").trim() === "") {
      continue;
    }
    if (isPyHeader(lines, ln) && indentOf(lines, ln) < hitIndent) {
      return ln;
    }
  }
  return -1;
}

function groupByPythonFunction(lines: string[], hits: RawFragment[]): HitGroup[] {
  const byHeader = new Map<number, RawFragment[]>();
  for (const hit of hits) {
    const header = enclosingPyHeader(lines, hit.line_start);
    const arr = byHeader.get(header) ?? [];
    arr.push(hit);
    byHeader.set(header, arr);
  }
  return [...byHeader.entries()]
    .map(([header, hs]) => ({ header, hits: hs }))
    .sort((a, b) => a.hits[0].char_start - b.hits[0].char_start);
}

function groupByGap(hits: RawFragment[]): HitGroup[] {
  const groups: HitGroup[] = [{ header: -1, hits: [hits[0]] }];
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].line_start - hits[i - 1].line_end > SITE_GAP_LINES) {
      groups.push({ header: -1, hits: [hits[i]] });
    } else {
      groups[groups.length - 1].hits.push(hits[i]);
    }
  }
  return groups;
}

function maxConfidence(hits: RawFragment[]): number {
  return hits.reduce((m, h) => Math.max(m, h.confidence), 0);
}

function lineEndOffset(content: string, starts: number[], line: number): number {
  return line + 1 < starts.length ? starts[line + 1] - 1 : content.length;
}

function unit(
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

function wholeFileUnit(
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
// (it would bias the analysis).
function headerEndOffset(
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

function regionUnit(
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

function pythonBlockUnit(
  content: string,
  starts: number[],
  lines: string[],
  hits: RawFragment[],
  header: number,
  maxChars: number
): RawFragment {
  const headerIndent = indentOf(lines, header);

  // Include decorators directly above the header.
  let top = header;
  for (let ln = header - 1; ln >= 0; ln--) {
    const t = (lines[ln] ?? "").trim();
    if (t === "") {
      continue;
    }
    if (t.startsWith("@")) {
      top = ln;
    } else {
      break;
    }
  }

  // Body extends until indentation returns to <= the header's indent.
  let end = lines.length - 1;
  for (let ln = header + 1; ln < lines.length; ln++) {
    if ((lines[ln] ?? "").trim() === "") {
      continue;
    }
    if (indentOf(lines, ln) <= headerIndent) {
      end = ln - 1;
      break;
    }
    end = ln;
  }
  const lastHit = hits[hits.length - 1].line_end;
  if (end < lastHit) {
    end = lastHit;
  }

  const cs = starts[top];
  let ce = lineEndOffset(content, starts, end);
  if (ce - cs > maxChars) {
    ce = cs + maxChars;
  }
  return unit(content, starts, cs, ce, hits);
}
