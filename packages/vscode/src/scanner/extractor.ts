// Tier 2 — heuristic fragment extraction (precision-first).
//
// This is the FALLBACK extraction path: the scanner prefers the tree-sitter AST
// extractor (ast/) and drops to these regex/tokenizer heuristics when a grammar
// can't load or a language has no grammar. Extraction only emits a fragment when
// there is a real signal: a string at a specific LLM call site, a message-array
// content/role key, a prompt-named assignment in a file that imports an LLM SDK,
// or telltale "You are …" content. Generic directory names and generic method
// calls are deliberately NOT signals.

import { extname, type PrefilterResult } from "./prefilter";
import {
  CONF,
  indentOf,
  type Lang,
  lineEndOffset,
  lineOf,
  lineStarts,
  LLM_CALLEES,
  looksLikeNaturalLanguage,
  MAX_FRAGMENTS_PER_FILE,
  PROMPT_WORD,
  type RawFragment,
  regionUnit,
  unit,
  wholeFileUnit,
} from "./shared";

export type { RawFragment } from "./shared";

const DEFAULT_MIN_CONFIDENCE = 0.6;
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
  ".java",
  ".cs",
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
  if (ext === ".py" || ext === ".pyi") return "python";
  if (ext === ".java") return "java";
  if (ext === ".cs") return "csharp";
  return "js";
}

function isIdentChar(c: string | undefined): boolean {
  return !!c && /[A-Za-z0-9_]/.test(c);
}

// ── specific LLM call sites ──────────────────────────────────────────────────

// Each shared callee with a trailing "(" finds it as a call in raw source, plus
// one heuristic-only pattern: the fluent builders (.prompt/.system/.user) are
// too generic on their own, so they only count when the argument is a string.
const CALL_SITE_PATTERNS: RegExp[] = [
  ...LLM_CALLEES.map((callee) => new RegExp(`${callee}\\s*\\(`, "g")),
  /\.(?:prompt|system|user)\s*\(\s*"/g,
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
    if (lang !== "python" && ch === "/" && content[i + 1] === "/") {
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (lang !== "python" && ch === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    const tok = readString(content, i, lang);
    if (tok) {
      toks.push(tok);
      i = tok.end;
      continue;
    }
    i++;
  }
  return toks;
}

function readString(
  content: string,
  i: number,
  lang: Lang
): StringTok | undefined {
  switch (lang) {
    case "python":
      return readPyString(content, i);
    case "java":
      return readJavaString(content, i);
    case "csharp":
      return readCsString(content, i);
    default:
      return readJsString(content, i);
  }
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

// Java: regular `"..."` (with escapes, single line) and text blocks `"""..."""`.
function readJavaString(content: string, start: number): StringTok | undefined {
  const quote = content[start];
  if (quote !== '"') {
    return undefined;
  }
  const triple = content[start + 1] === '"' && content[start + 2] === '"';
  const innerStart = start + (triple ? 3 : 1);
  let k = innerStart;
  while (k < content.length) {
    const c = content[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (triple) {
      if (c === '"' && content[k + 1] === '"' && content[k + 2] === '"') {
        break;
      }
    } else if (c === '"' || c === "\n") {
      break;
    }
    k++;
  }
  const innerEnd = k;
  const end = triple
    ? Math.min(content.length, k + 3)
    : content[k] === '"'
      ? k + 1
      : k;
  return { start, end, innerStart, innerEnd, inner: content.slice(innerStart, innerEnd) };
}

// C#: regular `"..."`, verbatim `@"..."` (where `""` is an escaped quote), raw
// `"""..."""`, and interpolated `$"..."` / `$@"..."` (treated like their base form).
function readCsString(content: string, start: number): StringTok | undefined {
  let j = start;
  let verbatim = false;
  let interpolated = false;
  // Consume any combination of `$` and `@` prefixes.
  while (content[j] === "$" || content[j] === "@") {
    if (content[j] === "@") verbatim = true;
    if (content[j] === "$") interpolated = true;
    j++;
  }
  const quote = content[j];
  if (quote !== '"') {
    return undefined;
  }
  if ((verbatim || interpolated) && isIdentChar(content[start - 1])) {
    return undefined;
  }
  const triple = content[j + 1] === '"' && content[j + 2] === '"';
  if (triple) {
    const innerStart = j + 3;
    let k = innerStart;
    while (k < content.length) {
      if (
        content[k] === '"' &&
        content[k + 1] === '"' &&
        content[k + 2] === '"'
      ) {
        break;
      }
      k++;
    }
    const innerEnd = k;
    const end = Math.min(content.length, k + 3);
    return { start, end, innerStart, innerEnd, inner: content.slice(innerStart, innerEnd) };
  }
  const innerStart = j + 1;
  let k = innerStart;
  while (k < content.length) {
    const c = content[k];
    if (verbatim) {
      if (c === '"') {
        if (content[k + 1] === '"') {
          k += 2; // escaped quote inside a verbatim string
          continue;
        }
        break;
      }
    } else {
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === '"' || c === "\n") {
        break;
      }
    }
    k++;
  }
  const innerEnd = k;
  const end = content[k] === '"' ? k + 1 : k;
  return { start, end, innerStart, innerEnd, inner: content.slice(innerStart, innerEnd) };
}

// ── confidence ───────────────────────────────────────────────────────────────

// Prompt-named binding signal. Accepts `=` (assignment) and `:` (object
// property / field with type), so JS/TS `{ systemPrompt: "…" }` and `prompt =`
// both match; trailing `\(?` allows parenthesized / implicitly-concatenated
// values like `system = (\n  "You are…"`.
const PROMPT_NAME_RE = new RegExp(
  `\\b[\\w$]*(?:${PROMPT_WORD})[\\w$]*\\s*(?::\\s*[\\w$<>[\\]. |]+)?\\s*[:=]\\s*\\(?\\s*$`,
  "i"
);

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
    conf = Math.max(conf, CONF.contentKey);
  }
  if (/["']?(system|user|assistant|developer)["']?\s*:\s*$/.test(before)) {
    conf = Math.max(conf, CONF.roleKey);
  }

  // prompt-named assignment — only trusted in a file that imports an LLM SDK.
  if (hasSdkImport && PROMPT_NAME_RE.test(before)) {
    conf = Math.max(conf, CONF.promptName);
  }

  // directional proximity to a specific LLM call site (call on/just-before line)
  for (let l = tokLine; l >= tokLine - CALL_ARG_WINDOW_LINES && l >= 0; l--) {
    if (callLines.has(l)) {
      conf = Math.max(conf, l === tokLine ? CONF.callSiteSameLine : CONF.callSiteNear);
      break;
    }
  }

  // strong telltale content signal (independent of imports). No leading \b so it
  // still fires when glued to an escape (e.g. "\nYou are"); no article required.
  if (/you are\b/i.test(tok.inner)) {
    conf = Math.max(conf, CONF.youAre);
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
