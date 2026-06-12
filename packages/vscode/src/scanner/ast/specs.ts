// Per-language structural knowledge for the AST extractor. Node-type names were
// confirmed by parsing fixtures with each grammar (see ast/*.test.ts). A spec
// classifies a single string-literal node by inspecting its surrounding tree:
// is it a message {role, content} value, a prompt-named binding, a direct
// argument of a known LLM call, or a prompt-ish JSX attribute?

import type { Node } from "@vscode/tree-sitter-wasm";
import type { AstLangId } from "./runtime";

export interface StringSpan {
  innerStart: number; // document offset just inside the opening quote/marker
  innerEnd: number; // document offset just before the closing quote/marker
}

export interface LanguageSpec {
  id: AstLangId;
  /** If `node` is a string literal we should consider, its inner span; else undefined.
   *  `content` is the full source, so prefixes/delimiters can be inspected by
   *  index without copying the node's text across the WASM boundary. */
  asString(node: Node, content: string): StringSpan | undefined;
  /** Wrapper node types climbed through to find a string's real value context. */
  wrapperTypes: ReadonlySet<string>;
  /** Object/dict key under which `value` sits (any key), or undefined. */
  pairKey(value: Node): string | undefined;
  /** Name of the var/field/kwarg `value` is bound to, or undefined. */
  bindingName(value: Node): string | undefined;
  /** Function-expression text if `value` is a direct argument of a call. */
  enclosingCallFn(value: Node): string | undefined;
  /** Annotation name if `value` is a direct argument of an annotation/attribute. */
  annotationName?(value: Node): string | undefined;
  /** Prompt-ish JSX attribute name if `value` is its value (js/tsx only). */
  jsxAttrName?(value: Node): string | undefined;
  /** Nearest enclosing function/method/class node, for codeScope grouping. */
  enclosingUnit(node: Node): Node | undefined;
}

// ── small tree helpers ───────────────────────────────────────────────────────

export function field(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}

/** Climb out through wrapper expressions (parens, concatenations, `+` chains). */
export function climb(node: Node, wrappers: ReadonlySet<string>): Node {
  let cur = node;
  while (cur.parent && wrappers.has(cur.parent.type)) {
    cur = cur.parent;
  }
  return cur;
}

/** Nearest ancestor whose type is in `types` (inclusive of `node`). */
export function ancestorOfType(
  node: Node,
  types: ReadonlySet<string>
): Node | undefined {
  let cur: Node | null = node;
  while (cur) {
    if (types.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function isValueField(parent: Node, value: Node, fieldName: string): boolean {
  return parent.childForFieldName(fieldName)?.id === value.id;
}

// ── Python ───────────────────────────────────────────────────────────────────

const PY_STRING_TYPES = new Set(["string"]);
const PY_WRAPPERS = new Set([
  "concatenated_string",
  "parenthesized_expression",
  "binary_operator", // `"a" + b` chains
]);
const PY_UNIT_TYPES = new Set(["function_definition", "class_definition"]);

const pythonSpec: LanguageSpec = {
  id: "python",
  wrapperTypes: PY_WRAPPERS,
  asString(node) {
    if (!PY_STRING_TYPES.has(node.type)) return undefined;
    // A `string` node is delimited by string_start / string_end children
    // (covering f/r/b/u prefixes and single vs. triple quotes); the inner text
    // is everything between them.
    const start = node.child(0);
    const end = node.child(node.childCount - 1);
    if (start?.type === "string_start" && end?.type === "string_end") {
      return { innerStart: start.endIndex, innerEnd: end.startIndex };
    }
    return { innerStart: node.startIndex + 1, innerEnd: node.endIndex - 1 };
  },
  pairKey(value) {
    const p = value.parent;
    if (p?.type === "pair" && isValueField(p, value, "value")) {
      return field(p, "key")?.text;
    }
    return undefined;
  },
  bindingName(value) {
    const p = value.parent;
    if (!p) return undefined;
    if (p.type === "assignment" && isValueField(p, value, "right")) {
      return field(p, "left")?.text;
    }
    if (p.type === "keyword_argument" && isValueField(p, value, "value")) {
      return field(p, "name")?.text;
    }
    return undefined;
  },
  enclosingCallFn(value) {
    const p = value.parent;
    if (p?.type === "argument_list" && p.parent?.type === "call") {
      return field(p.parent, "function")?.text;
    }
    return undefined;
  },
  enclosingUnit(node) {
    const fn = ancestorOfType(node, PY_UNIT_TYPES);
    // include a decorated_definition wrapper so decorators are part of the unit
    if (fn?.parent?.type === "decorated_definition") return fn.parent;
    return fn;
  },
};

// ── JavaScript / TypeScript / TSX (one spec, three grammars) ─────────────────

const JS_STRING_TYPES = new Set(["string", "template_string"]);
const JS_WRAPPERS = new Set(["binary_expression", "parenthesized_expression"]);
const JS_UNIT_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "class_declaration",
  "generator_function_declaration",
]);

function jsInnerSpan(node: Node): StringSpan {
  // string: " frag " ; template_string: ` frag ${} frag `. Both wrap the inner
  // text in one delimiter char on each side.
  return { innerStart: node.startIndex + 1, innerEnd: node.endIndex - 1 };
}

const jsSpec: LanguageSpec = {
  id: "javascript",
  wrapperTypes: JS_WRAPPERS,
  asString(node) {
    if (!JS_STRING_TYPES.has(node.type)) return undefined;
    return jsInnerSpan(node);
  },
  pairKey(value) {
    const p = value.parent;
    if (p?.type === "pair" && isValueField(p, value, "value")) {
      return field(p, "key")?.text;
    }
    return undefined;
  },
  bindingName(value) {
    const p = value.parent;
    if (!p) return undefined;
    if (p.type === "variable_declarator" && isValueField(p, value, "value")) {
      return field(p, "name")?.text;
    }
    if (
      (p.type === "public_field_definition" || p.type === "field_definition") &&
      isValueField(p, value, "value")
    ) {
      return field(p, "name")?.text;
    }
    if (p.type === "assignment_expression" && isValueField(p, value, "right")) {
      return field(p, "left")?.text;
    }
    return undefined;
  },
  enclosingCallFn(value) {
    const p = value.parent;
    if (p?.type === "arguments" && p.parent?.type === "call_expression") {
      return field(p.parent, "function")?.text;
    }
    return undefined;
  },
  jsxAttrName(value) {
    // value as `attr={`…`}` (jsx_expression wrapper) or `attr="…"` (direct).
    const viaExpr =
      value.parent?.type === "jsx_expression" ? value.parent.parent : value.parent;
    if (viaExpr?.type === "jsx_attribute") {
      return viaExpr.namedChild(0)?.text;
    }
    return undefined;
  },
  enclosingUnit(node) {
    const unit = ancestorOfType(node, JS_UNIT_TYPES);
    // hoist an arrow/function-expression to its declaration statement so
    // `const f = () => {…}` is one unit.
    if (
      (unit?.type === "arrow_function" || unit?.type === "function_expression") &&
      unit.parent
    ) {
      const stmt = ancestorOfType(
        unit,
        new Set(["lexical_declaration", "variable_declaration", "expression_statement"])
      );
      return stmt ?? unit;
    }
    return unit;
  },
};

// ── Java ─────────────────────────────────────────────────────────────────────

const JAVA_WRAPPERS = new Set(["binary_expression", "parenthesized_expression"]);
const JAVA_UNIT_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
  "class_declaration",
  "interface_declaration",
]);

// Return the declared name when `value` is the initializer of a `declType`
// declarator (the name is its first named child, distinct from the value).
function declaratorName(value: Node, declType: string): string | undefined {
  const p = value.parent;
  if (p?.type !== declType) return undefined;
  const name = p.namedChild(0);
  if (!name || name.id === value.id) return undefined;
  return name.text;
}

const javaSpec: LanguageSpec = {
  id: "java",
  wrapperTypes: JAVA_WRAPPERS,
  asString(node, content) {
    if (node.type !== "string_literal") return undefined;
    const triple = content.startsWith('"""', node.startIndex); // text block
    const pad = triple ? 3 : 1;
    return { innerStart: node.startIndex + pad, innerEnd: node.endIndex - pad };
  },
  pairKey() {
    return undefined;
  },
  bindingName(value) {
    const p = value.parent;
    if (p?.type === "assignment_expression" && isValueField(p, value, "right")) {
      return field(p, "left")?.text;
    }
    return declaratorName(value, "variable_declarator");
  },
  enclosingCallFn(value) {
    const p = value.parent;
    if (p?.type === "argument_list" && p.parent?.type === "method_invocation") {
      const name = field(p.parent, "name")?.text;
      return name ? `.${name}` : undefined;
    }
    return undefined;
  },
  annotationName(value) {
    const p = value.parent;
    if (
      p?.type === "annotation_argument_list" &&
      p.parent?.type === "annotation"
    ) {
      return field(p.parent, "name")?.text ?? p.parent.namedChild(0)?.text;
    }
    return undefined;
  },
  enclosingUnit(node) {
    return ancestorOfType(node, JAVA_UNIT_TYPES);
  },
};

// ── C# ───────────────────────────────────────────────────────────────────────

const CS_STRING_TYPES = new Set([
  "string_literal",
  "verbatim_string_literal",
  "raw_string_literal",
  "interpolated_string_expression",
]);
const CS_WRAPPERS = new Set(["binary_expression", "parenthesized_expression"]);
const CS_UNIT_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
  "local_function_statement",
  "property_declaration",
  "class_declaration",
]);

const csharpSpec: LanguageSpec = {
  id: "csharp",
  wrapperTypes: CS_WRAPPERS,
  asString(node, content) {
    if (!CS_STRING_TYPES.has(node.type)) return undefined;
    // Skip any `$` / `@` prefixes, then detect a `"""` raw/triple delimiter —
    // all by index into `content`, without copying node.text.
    let i = node.startIndex;
    while (content[i] === "$" || content[i] === "@") i++;
    const triple = content.startsWith('"""', i);
    const lead = i - node.startIndex + (triple ? 3 : 1);
    const tail = triple ? 3 : 1;
    return { innerStart: node.startIndex + lead, innerEnd: node.endIndex - tail };
  },
  pairKey() {
    return undefined;
  },
  bindingName(value) {
    const p = value.parent;
    if (p?.type === "assignment_expression" && isValueField(p, value, "right")) {
      return field(p, "left")?.text;
    }
    return declaratorName(value, "variable_declarator");
  },
  enclosingCallFn(value) {
    // C# wraps each call argument in an `argument` node.
    const arg = value.parent?.type === "argument" ? value.parent : value;
    const list = arg.parent;
    if (
      list?.type === "argument_list" &&
      list.parent?.type === "invocation_expression"
    ) {
      return field(list.parent, "function")?.text;
    }
    return undefined;
  },
  enclosingUnit(node) {
    return ancestorOfType(node, CS_UNIT_TYPES);
  },
};

// ── registry ─────────────────────────────────────────────────────────────────

export const SPECS: Record<AstLangId, LanguageSpec> = {
  python: pythonSpec,
  javascript: jsSpec,
  typescript: jsSpec,
  tsx: jsSpec,
  java: javaSpec,
  csharp: csharpSpec,
};

const EXT_TO_LANG: Record<string, AstLangId> = {
  ".py": "python",
  ".pyi": "python",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".jsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".java": "java",
  ".cs": "csharp",
};

export function astLangForExt(ext: string): AstLangId | undefined {
  return EXT_TO_LANG[ext];
}
