# Changelog

## 0.2.1

- New gallery icon matching the ai4dev / Prompt Radar brand logo.
- Removed the **Clear Session Log** command — a leftover from the removed research instrumentation.

## 0.2.0

Much more robust embedded-prompt detection.

- **Tree-sitter AST extraction** (deferred from v0.1) now ships. Prompts are extracted by parsing
  each file with a real grammar instead of regex/tokenizer heuristics, so detection is markedly more
  accurate — especially for JavaScript/TypeScript, which previously lagged Python. New coverage
  includes tagged template literals, JSX/TSX attributes, `[{role, content}]` message arrays,
  prompt-named class fields/properties, and proper per-function grouping (replacing the old
  line-gap heuristic). Strings in comments are no longer mistaken for prompts.
- **Two new languages: Java and C#** (`promptRadar.scan.languages` now defaults to
  `python, typescript, javascript, java, csharp`). Java: text blocks, Spring AI `ChatClient`,
  LangChain4j `@SystemMessage`/`@UserMessage`, `PromptTemplate`. C#: verbatim/raw/interpolated
  strings, Semantic Kernel, `ChatHistory.Add*Message`, OpenAI/Azure chat-message types.
- **Portable & resilient.** Grammars ship as WebAssembly — no native binaries, works across OS/arch.
  If a grammar can't load, the scanner automatically falls back to the v0.1 heuristic extractor, so
  a scan never fails.
- Multi-part prompts that the new extractor groups differently (merged concatenations / message
  arrays / shifted unit boundaries) get a fresh fragment id, so their prior analysis is re-run once.

## 0.1.0

First public release. Renamed from **Prompt Smells Analyzer** to **Prompt Radar** (all command and
setting IDs moved from `promptSmells.*` to `promptRadar.*`).

Prompt Radar turns a selection-only prompt linter into a workspace-scale prompt-quality tool:

- **Activity Bar side panel** with a Workspace Summary card (aggregate radar over analyzed
  fragments, smell counts by severity, completeness/pending state) and a Detected Prompts tree
  grouped file → fragment with score / smell-count / reviewed-N/M badges.
- **Local two-tier scanner** (no LLM): a file prefilter plus a heuristic fragment extractor for
  Python, TypeScript, and JavaScript, finding prompts near known LLM SDK call sites, message arrays,
  prompt-named assignments, and standalone prompt files. (Tree-sitter AST extraction is deferred to
  v0.2.)
- **Detector** with a bundled v1.0 prompt and seed catalog (5 dimensions: formatting, reliability,
  efficiency, security, safety), run at temperature 0 with deterministic in-code rescoring.
- **LLM provider abstraction:** BYOK via any OpenAI-compatible `/chat/completions` endpoint
  (`openaiCompatible` — OpenAI, DeepSeek, Gemini, Anthropic, Mistral, Groq, OpenRouter, xAI,
  Ollama/LM Studio, …) or Azure OpenAI, with the key in SecretStorage and automatic fallback to the
  VS Code Language Model API; a single typed error surface with an actionable side-panel banner.
- **Radar webview:** score + radar chart, natural-language summary, smells grouped by dimension with
  Agree/Disagree/Unsure responses + rationale, clickable evidence that jumps to the code, and a
  "+ Add missed smell" form.
- **Persistence:** the prompt index and your review responses persist under `.prompt-radar/`
  (auto-saved, debounced) and survive reloads. The directory is self-ignoring — a `.gitignore`
  is written on creation so the cached prompt text is never committed or shared by accident.
- **Opt-in feedback telemetry (off by default):** `promptRadar.telemetry.enabled` shares each
  feedback action (agree/disagree/unsure on a detected smell, or a reported missed smell) together
  with the analyzed prompt text, the detected smells, and the model used — anonymized, debounced,
  deduplicated, and always disabled when VS Code telemetry is off. Nothing is sent without
  feedback.
- **Batch analysis** of all detected prompts with a configurable concurrency limit (default 2) and
  cancellation.
- Inline diagnostics and hover are retained from the prior version, now read-only projections of the
  analysis, toggleable via `promptRadar.inline.diagnostics` / `promptRadar.inline.hover`.
