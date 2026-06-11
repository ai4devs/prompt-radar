// Fixed taxonomy and version constants for the v1.0 detector.
// The object shapes themselves are defined (and validated) in ./schema.ts;
// this module holds the constants both that schema and the rest of the code depend on.

/** The five fixed dimensions, in canonical order (spec §6.3). */
export const DIMENSIONS = [
  "formatting",
  "reliability",
  "efficiency",
  "security",
  "safety",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Severity scale, worst → least (spec §6.3). */
export const SEVERITIES = ["critical", "major", "moderate", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ARTIFACT_TYPES = [
  "prompt_template",
  "embedded_prompt",
  "not_a_prompt",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Bundled seed catalog version (resources/catalogs/catalog_v1.json). */
export const CATALOG_VERSION = "1.0";

/** Bundled detector prompt version (resources/prompts/detector_v1.txt). */
export const DETECTOR_PROMPT_VERSION = "1.0";

/** Human-readable labels for the dimensions, for UI. */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  formatting: "Formatting",
  reliability: "Reliability",
  efficiency: "Efficiency",
  security: "Security",
  safety: "Safety",
};

/** One-line, plain-English explanations shown on hover in the UI. */
export const DIMENSION_DESCRIPTIONS: Record<Dimension, string> = {
  formatting:
    "Is the prompt well organized and does it say what the answer should look like? For example: no output format given, many tasks mixed together, or repeated instructions.",
  reliability:
    "Is the task clear and will it behave the same way every time? For example: vague or conflicting instructions, forcing an answer, no examples, or edge cases not handled.",
  efficiency:
    "Does it avoid wasting tokens and calls? For example: unneeded or repeated context, too many examples, or overly long wording.",
  security:
    "Is it protected against malicious input? For example: user text mixed straight into the instructions, no separation of data from instructions, or secrets and personal data left in the prompt.",
  safety:
    "Does it stop the model from producing harmful content? For example: no rule to refuse bad requests, wording that is easy to jailbreak, or no limits on topics.",
};
