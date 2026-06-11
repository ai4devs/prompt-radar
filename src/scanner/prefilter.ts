// Tier 1 — file prefilter (spec §6.1). Pure string heuristics, no LLM, no AST.
//
// Precision-first (v0.1.1): a file is only a candidate when there is a REAL LLM
// signal — an SDK *import*, a dedicated prompt file, prompt-shaped config, or
// strong telltale prompt content. Generic directory names like `templates/`
// (Helm/k8s) are NOT a signal; they caused most false positives.

export interface PrefilterResult {
  /** Worth running fragment extraction over. */
  suspect: boolean;
  /** Treat the whole file as a single prompt fragment (dedicated prompt files). */
  standalone: boolean;
  /** A YAML/JSON config that contains prompt-shaped values. */
  configPrompt: boolean;
  /** The file imports a known LLM SDK. */
  hasSdkImport: boolean;
  reasons: string[];
}

const STANDALONE_EXTS = new Set([
  ".prompt",
  ".jinja",
  ".j2",
  ".tmpl",
  ".template",
]);

// Markdown is standalone only with an explicit prompt/agent naming convention.
const STANDALONE_MD_RE = /\.(agent|prompt|system)\.md$/i;

const CONFIG_EXTS = new Set([".yaml", ".yml", ".json"]);

const SDK_NAMES =
  "openai|anthropic|langchain|langchain_[a-z0-9_]+|llama_?index|dspy|litellm|semantic[_-]kernel|cohere|mistralai|groq|together|ollama|google\\.generativeai|vertexai";

// Python: `import openai` / `from langchain_core.prompts import ...`
const PY_IMPORT_RE = new RegExp(`^\\s*(?:from|import)\\s+(?:${SDK_NAMES})\\b`, "im");

// JS/TS: `import ... from "openai"` / `require("@anthropic-ai/sdk")`
const JS_IMPORT_RE =
  /\b(?:import|require)\b[^;\n]*['"](?:openai|@anthropic-ai\/sdk|@azure\/openai|@google\/generative-ai|@langchain\/[\w.-]+|langchain|cohere-ai|@mistralai\/[\w.-]+|@google-cloud\/vertexai|groq-sdk|together-ai|ollama|llamaindex)['"]/;

// Strong content signal usable even without an SDK import (code files). No
// leading \b so it still matches when glued to an escape (e.g. "\nYou are"),
// and no article requirement so "You are FreeBot" matches too.
const YOU_ARE_RE = /you are\b/i;
const ROLE_LITERAL_RE = /["']role["']\s*:\s*["'](system|user|assistant)["']/;

// Prompt-shaped YAML/JSON config (confirmation: scan config only when prompt-shaped).
const CONFIG_PROMPT_RES: RegExp[] = [
  /^\s*-?\s*role\s*:\s*["']?(system|user|assistant)\b/im, // yaml message list
  /^\s*(system_prompt|prompt)\s*:\s*\S/im, // yaml prompt key with a value
  /["'](role)["']\s*:\s*["'](system|user|assistant)["']/, // json
  /you are\b/i,
];

export function extname(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

export function hasSdkImport(content: string): boolean {
  return PY_IMPORT_RE.test(content) || JS_IMPORT_RE.test(content);
}

export function prefilter(relPath: string, content: string): PrefilterResult {
  const ext = extname(relPath);
  const reasons: string[] = [];

  let standalone = false;
  if (STANDALONE_EXTS.has(ext) || STANDALONE_MD_RE.test(relPath)) {
    standalone = true;
    reasons.push("dedicated prompt file");
  }

  const sdk = hasSdkImport(content);
  if (sdk) {
    reasons.push("imports an LLM SDK");
  }

  const configPrompt =
    CONFIG_EXTS.has(ext) && CONFIG_PROMPT_RES.some((re) => re.test(content));
  if (configPrompt) {
    reasons.push("prompt-shaped config");
  }

  const strongTelltale = YOU_ARE_RE.test(content) || ROLE_LITERAL_RE.test(content);
  if (strongTelltale) {
    reasons.push("telltale prompt content");
  }

  const suspect = standalone || sdk || configPrompt || strongTelltale;
  return { suspect, standalone, configPrompt, hasSdkImport: sdk, reasons };
}
