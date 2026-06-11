import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAggregate } from "./aggregate";
import type { Fragment } from "../model/types";
import type { DetectorJSON } from "../detector/schema";

function output(scores: number[], smells: Array<{ severity: string }>): DetectorJSON {
  const dims = ["formatting", "reliability", "efficiency", "security", "safety"];
  return {
    artifact_type: "embedded_prompt",
    fragments_analyzed: 1,
    overall_score: 0,
    summary: "",
    dimensions: dims.map((dimension, i) => ({
      dimension,
      score: scores[i],
      smells:
        i === 0
          ? smells.map((s, j) => ({
              id: `x${j}`,
              name: "n",
              novel: false,
              severity: s.severity,
              confidence: 0.9,
              description: "d",
              rationale: "r",
              evidence: "e",
              location: { char_start: 0, char_end: 1, line: 1 },
              remediation: "fix",
            }))
          : [],
    })),
  } as DetectorJSON;
}

function frag(id: string, toolOutput?: DetectorJSON, failed?: boolean): Fragment {
  return {
    id,
    file: "a.py",
    span: { char_start: 0, char_end: 1, line_start: 0, line_end: 0 },
    artifactType: "embedded_prompt",
    artifactText: "x",
    artifactTextSha256: "h",
    confidence: 1,
    toolOutput,
    scannedAt: "t",
    failed,
  };
}

test("empty index → null means, zero counts", () => {
  const a = computeAggregate([]);
  assert.equal(a.detected, 0);
  assert.equal(a.analyzed, 0);
  assert.equal(a.overall, null);
  assert.equal(a.dimensionMeans.formatting, null);
});

test("means computed over analyzed only; pending counts unanalyzed", () => {
  const f1 = frag("1", output([4, 3, 5, 2, 5], [{ severity: "minor" }]));
  const f2 = frag("2"); // unanalyzed
  const a = computeAggregate([f1, f2]);
  assert.equal(a.detected, 2);
  assert.equal(a.analyzed, 1);
  assert.equal(a.pending, 1);
  assert.equal(a.dimensionMeans.security, 2);
  // overall = mean of 5 dimension means = (4+3+5+2+5)/5 = 3.8
  assert.equal(a.overall, 3.8);
  assert.equal(a.severityCounts.minor, 1);
});

test("failed fragments are counted but contribute no scores", () => {
  const a = computeAggregate([frag("1", undefined, true)]);
  assert.equal(a.failed, 1);
  assert.equal(a.analyzed, 0);
  assert.equal(a.overall, null);
});

test("not_a_prompt fragments are excluded from means and counted separately", () => {
  const real = frag("1", output([4, 3, 5, 2, 5], [{ severity: "minor" }]));
  const na = frag("2", {
    ...output([5, 5, 5, 5, 5], []),
    artifact_type: "not_a_prompt",
  } as DetectorJSON);
  const a = computeAggregate([real, na]);
  assert.equal(a.detected, 2);
  assert.equal(a.analyzed, 1);
  assert.equal(a.notPrompt, 1);
  assert.equal(a.overall, 3.8); // only the real fragment, not skewed toward 5
  assert.equal(a.dimensionMeans.security, 2);
});
