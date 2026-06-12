// AST-based fragment extraction. Walks the parse tree, and for each string
// literal decides — structurally, not by scanning nearby text — whether it is a
// prompt and how confident we are. Produces the same RawFragment[] shape as the
// heuristic extractor, with inner-content offsets so single-literal fragment IDs
// match the heuristic path.

import type { Node } from "@vscode/tree-sitter-wasm";
import {
  CONF,
  type Lang,
  type RawFragment,
  lineOf,
  lineStarts,
  looksLikeNaturalLanguage,
  MAX_FRAGMENTS_PER_FILE,
} from "../shared";
import type { CodeScope } from "../extractor";
import { climb, type LanguageSpec } from "./specs";
import { groupAstHits, type UnitHit } from "./grouping";
import type { AstLangId, ParserHandle } from "./runtime";

// Names (binding / object key) that mark a value as prompt-ish.
const PROMPT_WORD_RE = /(?:prompt|template|system|instruction|messages?|msg|sys)/i;
// JSX attribute names that carry a prompt.
const PROMPT_ATTR_RE = /(?:prompt|system|instruction)/i;
// Java/C# annotation/attribute names whose string argument IS a prompt.
const PROMPT_ANNOTATION_RE = /(?:system|user|assistant)message/i;
// Function-expression text of a known LLM call whose direct string arg is a prompt.
const KNOWN_CALL_RE =
  /(?:\.chat\.completions\.create|\.messages\.create|\.completions\.create|\.responses\.create|ChatCompletion\.create|litellm\.a?completion|(?:Chat)?PromptTemplate|\.from_template|\.from_messages|(?:System|Human|User|AI)Message|InvokePromptAsync|Create(?:FunctionF|f)romPrompt|\.Add(?:System|User|Assistant)Message|(?:System|User|Assistant)ChatMessage|ChatRequest(?:System|User|Assistant)Message|\.(?:prompt|system|user)\b)/;

export interface AstExtractOptions {
  minConfidence: number;
  hasSdkImport: boolean;
}

export interface AstUnitOptions extends AstExtractOptions {
  scope: CodeScope;
  maxChars: number;
}

function sharedLang(id: AstLangId): Lang {
  if (id === "python") return "python";
  if (id === "java") return "java";
  if (id === "csharp") return "csharp";
  return "js";
}

// Walk the tree once, collecting each prompt string together with the span of
// its enclosing function/method/class (for codeScope grouping).
function collect(
  content: string,
  handle: ParserHandle,
  spec: LanguageSpec,
  opts: AstExtractOptions
): UnitHit[] {
  const tree = handle.parser.parse(content);
  if (!tree) {
    return [];
  }
  try {
    const starts = lineStarts(content);
    const out: UnitHit[] = [];

    // Iterative DFS over named nodes; string nodes are leaves we don't descend.
    const stack: Node[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const span = spec.asString(node);
      if (span) {
        const text = content.slice(span.innerStart, span.innerEnd);
        if (looksLikeNaturalLanguage(text)) {
          const confidence = classify(node, text, spec, opts.hasSdkImport);
          if (confidence >= opts.minConfidence) {
            const unitNode = spec.enclosingUnit(node);
            out.push({
              frag: {
                char_start: span.innerStart,
                char_end: span.innerEnd,
                line_start: lineOf(starts, span.innerStart),
                line_end: lineOf(starts, Math.max(span.innerStart, span.innerEnd - 1)),
                text,
                confidence,
                artifactType: "embedded_prompt",
              },
              unitStart: unitNode ? unitNode.startIndex : -1,
              unitEnd: unitNode ? unitNode.endIndex : -1,
            });
          }
        }
        continue; // don't descend into the string's tokens
      }
      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child) stack.push(child);
      }
    }

    out.sort((a, b) => a.frag.char_start - b.frag.char_start);
    return out.slice(0, MAX_FRAGMENTS_PER_FILE);
  } finally {
    tree.delete();
  }
}

/** Extract per-string prompt candidates (granular; the `fragments` view). */
export function astExtractHits(
  content: string,
  handle: ParserHandle,
  spec: LanguageSpec,
  opts: AstExtractOptions
): RawFragment[] {
  return collect(content, handle, spec, opts).map((h) => h.frag);
}

/** Extract code units honoring codeScope (auto / file / fragments). */
export function astExtract(
  content: string,
  handle: ParserHandle,
  spec: LanguageSpec,
  opts: AstUnitOptions
): RawFragment[] {
  const hits = collect(content, handle, spec, opts);
  return groupAstHits(content, sharedLang(spec.id), hits, opts.scope, opts.maxChars);
}

function classify(
  node: Node,
  text: string,
  spec: LanguageSpec,
  hasSdkImport: boolean
): number {
  const value = climb(node, spec.wrapperTypes);
  let conf = 0;

  const key = spec.pairKey(value);
  if (key) {
    if (/^content$/i.test(key)) {
      conf = Math.max(conf, CONF.contentKey);
    } else if (PROMPT_WORD_RE.test(key) && hasSdkImport) {
      conf = Math.max(conf, CONF.promptName);
    }
  }

  const bind = spec.bindingName(value);
  if (bind && PROMPT_WORD_RE.test(bind) && hasSdkImport) {
    conf = Math.max(conf, CONF.promptName);
  }

  const fn = spec.enclosingCallFn(value);
  if (fn && KNOWN_CALL_RE.test(fn)) {
    conf = Math.max(conf, CONF.callSiteSameLine);
  }

  const annotation = spec.annotationName?.(value);
  if (annotation && PROMPT_ANNOTATION_RE.test(annotation)) {
    conf = Math.max(conf, CONF.promptArg);
  }

  const attr = spec.jsxAttrName?.(value);
  if (attr && PROMPT_ATTR_RE.test(attr)) {
    conf = Math.max(conf, CONF.promptArg);
  }

  if (/you are\b/i.test(text)) {
    conf = Math.max(conf, CONF.youAre);
  }

  return conf;
}
