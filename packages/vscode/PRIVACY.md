# Prompt Radar — Privacy Policy

**Effective date:** June 12, 2026

## Summary

- Prompt Radar collects **nothing by default**.
- Data is shared only if **both** are true: you explicitly opted in
  (`promptRadar.telemetry.enabled`), **and** you actively give feedback on an
  analysis result. If you never click agree/disagree/unsure or report a missed
  smell, nothing is ever sent — even with telemetry enabled.
- Shared data is **anonymous**: there are no accounts, and we receive no name,
  email, IP-based profile, or machine name.
- Your API keys and your workspace content (beyond the specific prompt you
  analyzed and gave feedback on) are **never** collected.

## What is collected, and when

When telemetry is enabled and you respond to a detected prompt smell
(agree / disagree / unsure, with an optional comment) or report a smell the
detector missed, one feedback event is uploaded containing:

- your feedback: the decision, your optional comment, and timing metadata
  (when the smell was shown, when you responded, how often you revised it);
- the prompt that was analyzed: its verbatim text, a content hash, the
  artifact type, and its workspace-relative file path (e.g.
  `src/agents/planner.py` — never an absolute path or machine name);
- the analysis context: the smell you judged, a compact list of all smells the
  detector found, per-dimension scores, and the detector's summary;
- the model that produced the analysis (e.g. `copilot/gpt-4o`), and the
  extension / smell-catalog / detector-prompt versions;
- VS Code's built-in anonymous machine identifier (`machineId`), used only to
  group feedback from the same installation.

Telemetry is additionally disabled — regardless of the extension setting —
whenever VS Code's global telemetry (`telemetry.telemetryLevel`) is off.

## What is never collected

API keys or other secrets; absolute file paths, machine or user names;
workspace files you did not analyze; analysis results you gave no feedback on;
your VS Code settings; anything while `promptRadar.telemetry.enabled` is off.

## Why we collect it

Feedback on detected smells (especially disagreements and missed smells) is
used to improve the prompt-smell catalog and the detector prompt, and to
publish aggregate research about prompt quality. It is not used for
advertising and is never sold.

## Where the data goes

Events are stored in a Supabase (PostgreSQL) database controlled by the
publisher, hosted in the European Union (AWS Central EU — Frankfurt,
`eu-central-1`). The credential embedded in the extension can only *append*
feedback rows; it cannot read, modify, or delete anything (enforced by
database row-level security).

## LLM analysis is separate from telemetry

To analyze a prompt, its text is sent to the LLM provider **you** configure
(the VS Code Language Model API / GitHub Copilot, or your own
endpoint). That traffic goes directly from your machine to your provider
under your agreement with them; it is not part of this telemetry and never
passes through our servers.

## Local data

Analysis results and your feedback are stored locally in a `.prompt-radar/`
folder in your workspace so they survive reloads. This data stays on your
machine (add the folder to `.gitignore` if you don't want it committed).

## Retention and deletion

Feedback events are kept for as long as they are useful for improving the
catalog and for research. To have your data deleted, email the contact below
and include your anonymous machine id — it is printed in the **Prompt Radar**
output channel whenever feedback is uploaded. We will delete all rows for that
id.

## Changes

If a future version collects different data, this policy and the extension's
changelog will say so, and the change will never retroactively widen what an
existing opt-in covers — material changes re-trigger the opt-in prompt.

## Contact

Vanilson Burégio — <vanilson@gmail.com>
