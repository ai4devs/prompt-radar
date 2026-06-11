import { test } from "node:test";
import assert from "node:assert/strict";
import { DetectorJSONSchema } from "./schema";
import { recomputeScores, scoreForSmells } from "./scoring";

// The worked example from spec §6.3 (the prompt's own EXAMPLE block).
const EXAMPLE = {
  artifact_type: "embedded_prompt",
  fragments_analyzed: 1,
  overall_score: 0, // intentionally wrong; recomputeScores must derive 3.8
  summary: "An embedded f-string prompt.",
  dimensions: [
    {
      dimension: "formatting",
      score: 1,
      smells: [
        {
          id: "formatting.no_output_contract",
          name: "No output format specified",
          novel: false,
          severity: "minor",
          confidence: 0.7,
          description: "No format stated.",
          rationale: "Hard to parse.",
          evidence: "Answer the question: {user_input}.",
          location: { char_start: 30, char_end: 62, line: 1 },
          remediation: "State the format.",
        },
      ],
    },
    {
      dimension: "reliability",
      score: 1,
      smells: [
        {
          id: "reliability.forced_answer",
          name: "Forced answer encourages fabrication",
          novel: false,
          severity: "moderate",
          confidence: 0.8,
          description: "Always answer.",
          rationale: "Increases hallucination.",
          evidence: "Always give an answer.",
          location: { char_start: 63, char_end: 85, line: 1 },
          remediation: "Permit I don't know.",
        },
      ],
    },
    { dimension: "efficiency", score: 1, smells: [] },
    {
      dimension: "security",
      score: 1,
      smells: [
        {
          id: "security.unsanitized_input_concat",
          name: "Unsanitized user input concatenation",
          novel: false,
          severity: "major",
          confidence: 0.9,
          description: "Raw interpolation.",
          rationale: "Prompt injection.",
          evidence: "{user_input}",
          location: { char_start: 49, char_end: 61, line: 1 },
          remediation: "Delimit user input.",
        },
      ],
    },
    { dimension: "safety", score: 1, smells: [] },
  ],
};

test("§6.3 example validates against the detector schema", () => {
  const parsed = DetectorJSONSchema.safeParse(EXAMPLE);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("worst-severity scoring per dimension", () => {
  assert.equal(scoreForSmells([]), 5);
  assert.equal(scoreForSmells([{ severity: "minor" } as never]), 4);
  assert.equal(scoreForSmells([{ severity: "moderate" } as never]), 3);
  assert.equal(scoreForSmells([{ severity: "major" } as never]), 2);
  assert.equal(scoreForSmells([{ severity: "critical" } as never]), 1);
  assert.equal(
    scoreForSmells([{ severity: "minor" }, { severity: "critical" }] as never),
    1
  );
});

test("recomputeScores reproduces the §6.3 example (overall 3.8)", () => {
  const parsed = DetectorJSONSchema.parse(EXAMPLE);
  const rescored = recomputeScores(parsed);
  const byDim = Object.fromEntries(
    rescored.dimensions.map((d) => [d.dimension, d.score])
  );
  assert.equal(byDim.formatting, 4);
  assert.equal(byDim.reliability, 3);
  assert.equal(byDim.efficiency, 5);
  assert.equal(byDim.security, 2);
  assert.equal(byDim.safety, 5);
  assert.equal(rescored.overall_score, 3.8);
});
