# Prompt Radar

Scan a workspace for prompt fragments, analyze them for **prompt smells** with an LLM, and review the findings on an interactive radar.

Prompt Radar scores every prompt across five quality dimensions:

| Dimension | What it measures |
|-----------|-----------------|
| Formatting | Clear structure and explicit output expectations |
| Reliability | Specific, stable instructions that reduce ambiguity |
| Efficiency | Concise wording without unnecessary token cost |
| Security | Reduced risk of leakage, injection, or sensitive exposure |
| Safety | Lower risk of harmful, biased, or policy-problematic outputs |

## Getting started

1. Open the **Prompt Radar** view in the Activity Bar.
2. Run **Scan Workspace** — a local, heuristic scan (no LLM calls) that finds prompt fragments in Python/TypeScript/JavaScript code, prompt-shaped YAML/JSON, and dedicated prompt files (`*.prompt`, `*.jinja`, `*.agent.md`, …).
3. Click a detected fragment (or run **Analyze All Detected Prompts**) to analyze it. Every LLM call is an explicit user action.
4. Review each finding in the radar panel — agree/disagree/unsure with an optional rationale, jump to the evidence in code, and add smells the detector missed.

## LLM providers

- **VS Code Language Model (default):** uses the VS Code Language Model API (e.g. GitHub Copilot). Optionally pin a model family via `promptRadar.model`.
- **Azure OpenAI (BYOK):** set `promptRadar.provider` to `azureOpenAI`, fill in `promptRadar.azure.endpoint` / `deployment` / `apiVersion`, and store your API key with **Prompt Radar: Configure API Key**. The key lives in VS Code Secret Storage — never in `settings.json`.

## Key settings

| Setting | Default | Description |
|---------|---------|-------------|
| `promptRadar.provider` | `vscodeLM` | LLM provider (`vscodeLM` or `azureOpenAI`) |
| `promptRadar.scan.languages` | `python, typescript, javascript` | Languages the scanner extracts fragments from |
| `promptRadar.scan.minConfidence` | `0.6` | Minimum detection confidence for a fragment to be kept |
| `promptRadar.scan.codeScope` | `auto` | How prompts in source code are grouped before analysis |
| `promptRadar.maxConcurrent` | `2` | Concurrency limit for batch analysis |
| `promptRadar.inline.diagnostics` | `true` | Show smells as squiggles in analyzed files |
| `promptRadar.inline.hover` | `true` | Show smell details on hover |

## Data & privacy

- Scanning is fully local; prompt text is only sent to the configured LLM provider when you explicitly analyze a fragment.
- Analysis results and review responses persist under `.prompt-radar/` in the workspace (add it to `.gitignore` if you don't want it committed).
- **Telemetry is opt-in and off by default.** With `promptRadar.telemetry.enabled` on, each feedback action you take — agreeing/disagreeing with a detected smell (with any comment) or reporting a missed one — is shared anonymously to help improve the smell catalog, together with the analyzed prompt text, the detected smells, the model used, and VS Code's anonymous machine id. Nothing is sent if you never give feedback. API keys and other workspace content are never sent, and telemetry is also disabled whenever VS Code telemetry (`telemetry.telemetryLevel`) is off. Full details: [Privacy Policy](PRIVACY.md).

## License

MIT
