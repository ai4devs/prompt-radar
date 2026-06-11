# NOTES — Prompt Radar v0.1 refactor

Exploration findings and decisions for the refactor of **Prompt Smells Analyzer** (v0.0.1, M1–M4)
into **Prompt Radar** (v0.1.0). Skim this; it is not a design doc. Source of truth for the target is
`docs/prompt_radar_gui_spec_v0_1.md`.

## Architecture summary (as found)

A small (~9 source files) esbuild-built TypeScript extension. `src/extension.ts` is the composition
root. Analysis was **selection-only**: right-click *Analyze Selection* → `VsCodeLmAnalyzer` calls
`vscode.lm` (temperature 0, Zod-validated JSON) → results fan out to three presenters: Problems-panel
diagnostics, a hover provider, and a Chart.js radar `WebviewPanel`. No workspace scanner, no
persistence, no provider abstraction. Two esbuild targets: `extension.ts` (Node CJS) and
`webview/radar.ts` (browser IIFE). Strict CSP + per-render nonce in the webview. Lazy activation
(`activationEvents: []`, auto-derived from contributed commands).

## File-by-file inventory (as found)

| File | Role |
|---|---|
| `package.json` | Manifest: 3 `promptSmells.*` commands, 1 setting (`promptSmells.model` enum), editor/context menu, engine `^1.95.0`, deps chart.js + zod. No vsce/eslint. |
| `esbuild.js` | Two targets; webview build wrapped in try/catch (early-milestone guard). |
| `tsconfig.json` | strict, ESNext/bundler, `noEmit` (type-check only). |
| `src/extension.ts` | `activate()` wires OutputChannel + analyzer + diagnostics + hover + radar; 3 commands; hover on `"*"`. |
| `src/analyzer/VsCodeLmAnalyzer.ts` | `vscode.lm.selectChatModels({family?})` → `sendRequest` (temp 0), stream, `parseJson` (balanced-brace fallback), Zod validate, retry-once. **`parseJson` reused.** |
| `src/analyzer/systemPrompt.ts` | Detector prompt **inlined in TS** (moved to a bundled resource). |
| `src/analyzer/schema.ts` | Old shape: cats `security/safety/formatting/cost/reliability`; `AnalysisResult{overallScore,summary,categoryScores{},smells[]}`; sev `error/warning/info`. |
| `src/analyzer/PromptAnalyzer.ts` | `PromptAnalyzer` iface + `NoModelError`/`MalformedOutputError`. |
| `src/presentation/diagnostics.ts` | `buildDiagnostics()` maps smells → ranges via `indexOf(evidence)`. |
| `src/presentation/hoverProvider.ts` | `SmellHoverProvider` keyed by document URI. |
| `src/presentation/radarPanel.ts` | `RadarPanel`: `createWebviewPanel` (Beside), CSP+nonce, `asWebviewUri`, msg protocol host→`render` / webview→`ready`. |
| `src/webview/radar.ts` | Chart.js radar (vanilla TS), **inverts scores (`5 - score`)**, clickable labels → detail/picker + smell cards. |

## Radar webview: tech stack & verdict

Chart.js 4.5.1 `RadarController`, vanilla TS, strict CSP + per-render nonce, `asWebviewUri` to a
bundled IIFE. Clean, secure, maintainable. **Verdict: REUSE** the chart component + host scaffold,
**REWRITE** the interaction/detail layer for the new smell shape and the review UI (radios, rationale,
evidence-jump, missed-smell, export, consent). Reuse ≈ 40% (chart + color helpers) / 60% rewritten.

## Current "Analyze" command flow (end to end)

`promptSmells.analyzeSelection` (`extension.ts:15`) → capture `editor.selection` text → `withProgress`
→ `analyzer.analyze(text)` → `selectChatModels` + `sendRequest` (temp 0) → stream → `parseJson` → Zod
validate → recompute overall → `buildDiagnostics` + `setSmells` + `radarPanel.show(result)` → host
posts `render` → webview draws radar.

## How `vscode.lm` is invoked (as found)

`vscode.lm.selectChatModels(family ? {family} : {})`, uses `allModels[0]`; two `User` messages
(system prompt + templated selection); `sendRequest(messages, {justification, modelOptions:{
temperature:0}}, token)`; response via `for await (chunk of response.text)`; JSON parsed full →
first-balanced-`{...}` fallback; retry once (consent-dialog race). This logic is ported into
`VsCodeLmProvider` behind the new `LLMProvider` interface.

## Reuse / rewrite verdict per component

| Component | Verdict | One-liner |
|---|---|---|
| Chart.js radar (chart + colors) | Reuse | feed raw `dimensions[].score` (5 = clean); drop inversion |
| Webview host (CSP/nonce/uri) | Adapt | new message protocol + 3 open paths |
| Detail/picker/smell-card DOM | Rewrite | new smell shape + review radios |
| `VsCodeLmAnalyzer` | Refactor → split | becomes `VsCodeLmProvider`; keep `parseJson` |
| `schema.ts` / `systemPrompt.ts` | Replace | `dimensions[]` schema; prompt → bundled resource |
| `diagnostics.ts` / `hoverProvider.ts` | Keep + repoint | project from `PromptIndex`, gated by settings |
| `extension.ts` | Rewrite | composition root for new services |
| Scanner / model / persistence / export / side panel | Build new | §6.1, §8.1, §8.2, §5.1 |

## Behavior changes

- **Renamed** `prompt-smells` → `prompt-radar`; every `promptSmells.*` command/setting →
  `promptRadar.*`; displayName "Prompt Smells Analyzer" → "Prompt Radar"; output channel "Prompt
  Smells" → "Prompt Radar". Publisher kept (`vanilson`). **Old identifiers, for recovery:**
  commands `promptSmells.analyzeSelection` / `promptSmells.clearDiagnostics` /
  `promptSmells.showRadar`; setting `promptSmells.model`; package `prompt-smells`.
- Dimension `cost` → `efficiency`; smell severities `error|warning|info` →
  `minor|moderate|major|critical`; result shape `categoryScores{}` → `dimensions[]`.
- Analysis is now scan-driven across the workspace in addition to selection; all LLM calls remain
  explicit user actions.
- **Radar orientation (inversion call):** no screenshot was available in the repo to confirm against,
  so the call is made from schema semantics. The new detector score is `5 = no smells` (clean) down to
  `1 = critical`, i.e. already "health-like". The radar therefore plots the **raw** dimension score,
  so **a larger polygon = a healthier prompt** — the same visual meaning the old UI achieved via its
  `5 - score` inversion (which existed only because the old schema used 5 = worst). The inversion is
  removed; visual semantics are unchanged.

## Retained from prior version

- **Inline diagnostics** (Problems-panel squiggles) and **hover** — kept (spec §12 meant "don't build
  these", not "delete working ones"). Now pure read-only projections of `PromptIndex` (no independent
  LLM calls), toggleable via `promptRadar.inline.diagnostics` / `promptRadar.inline.hover` (default
  true). Diagnostic severity map: critical/major → Error, moderate → Warning, minor → Information.
- `promptRadar.model` (renamed from `promptSmells.model`) — preserves `vscode.lm` family selection for
  the fallback provider.

## Deviations from brief

- **§6.2 scanner**: ships a **heuristic** Tier-2 fragment extractor instead of tree-sitter AST for
  v0.1. Reason: cross-platform `.vsix` packaging risk (native binaries / WASM ABI) on a 48h ship to
  ~30 mixed-OS student machines outweighs the precision gain on student code. A `TODO(v0.2)` marks
  the scanner head; real AST extraction is deferred to v0.2.

### v0.1.1 — scanner precision + observability + LLM reliability
After testing on a large YAML-heavy monorepo (Helm charts, Nuxt build output) the heuristic produced
many false positives. Tightened to a **precision-first** design:
- Detection now requires a real LLM signal: an SDK **import** (import-context regex, not the word
  anywhere), a **specific** LLM call site (dropped generic `.invoke(`/`.generate(`/`.create(`), a
  prompt-named assignment **in an SDK-importing file**, or telltale "You are …" content.
- Dropped the generic `templates/`/`system/`/`agents/` path rules (the Helm flood). Standalone =
  dedicated prompt extensions + `*.agent.md`/`*.prompt.md`/`*.system.md` only.
- YAML/JSON scanned **only when prompt-shaped** (`role:`/`system_prompt:`/`prompt:`/"You are"); the
  whole file is analyzed as one prompt (the message array) — see v0.1.2.
- Built-in `BASE_EXCLUDES` (`.nuxt`, `.next`, `build`, `out`, `coverage`, `vendor`, `*.min.js`, …)
  always applied; minified/generated files skipped by a longest-line guard.
- New settings: `promptRadar.scan.minConfidence` (default 0.6), `promptRadar.log.verbose`.
- **Observability:** a `Logger` (src/util/logger.ts) writes scan + provider + per-LLM-call
  (request/response/timing/parse/scores) + lifecycle logs to the *Prompt Radar* output channel,
  which auto-shows on the first analysis.
- **vscodeLM reliability:** when the configured `promptRadar.model` family matches no model,
  `VsCodeLmProvider` now logs a warning and falls back to any available model instead of erroring
  (the likely cause of "the radar was never generated by an LLM call").
- `examples/lab-corpus/` added (excluded from the vsix) — Python apps with known prompt smells +
  decoys, for the student experiment and as scanner-precision validation data.

### v0.1.2 — code-unit extraction (let the LLM extract prompts from source)
Heuristic per-string extraction split multi-part prompts and partially captured them. Now the
**unit** sent to the detector for source code is configurable via `promptRadar.scan.codeScope`:
- `auto` (default): the heuristic locates prompt strings, then groups them by **enclosing function**
  (Python def/class block; gap-based elsewhere). A file with one prompt → the **whole file** (best
  context); a file with prompts in several functions → **one unit per function**. The detector (its
  existing per-fragment call — no new LLM calls) extracts and analyzes the real prompt from the unit.
- `file`: always one whole-file unit. `fragments`: legacy one-per-string.
- Standalone prompt files **and prompt-shaped YAML/JSON** are analyzed as one **whole-file** unit
  (an agent config's message array is a single prompt, not separate role/content fragments). Code
  units are capped to `MAX_ARTIFACT_CHARS` (≈16k) with a bounded-region fallback for very large files.

## Implementation choices (cosmetic / no-UX-impact, per §13)

- **Side panel = 2 views + title actions.** Activity-bar container with a `promptRadar.summary`
  webview view and a `promptRadar.prompts` tree view; the action bar is `view/title` navigation
  icons (Scan, Rescan, Analyze All, Export) plus Configure-Key/Clear-Log, not a third view. A
  `viewsWelcome` gives the empty tree a "Scan Workspace" button.
- **Summary radar = host-rendered inline SVG** (not Chart.js). Self-contained, CSP-clean, and avoids
  a second webview bundle; the full radar panel uses Chart.js.
- **Missed-smell span source** (a §13 question): the current editor selection when it lies inside the
  fragment, otherwise the whole fragment span.
- **`analyzeSelection`** now creates a Fragment from the selection (confidence 1.0), stores it in the
  index, and opens the radar — so selections are reviewable/exportable like scanned fragments.
- **Re-scan preserves analysis** for byte-identical fragments (same id + sha256), so a re-scan
  doesn't discard prior detector output or responses.
- **No session-id reset on reload**: the session id + start time persist in `.prompt-radar/`.
- Severity→diagnostic mapping, response payload (`shownAt` captured at first render; `changedCount`
  incremented per revision in the store), and the consent-banner copy are per the user's
  confirmations.

## Open / deferred (v0.2)

Tree-sitter AST extraction; Tier-3 LLM verification; CodeLens / gutter decorations / status bar /
auto-rescan; multi-catalog selector; languages beyond Python + TS/JS; i18n. (Spec §12.)
