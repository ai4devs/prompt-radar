import { DIMENSIONS, type Dimension, type Severity } from "./types";
import type { DetectorJSON, DimensionResult, Smell } from "./schema";

// Deterministic scoring (spec §6.3): each dimension scores 1–5 from the WORST
// severity present; overall_score is the mean of the five dimension scores,
// rounded to one decimal. The model's own scores are advisory — we recompute
// them in code so the radar is a pure function of the smells found.
const SCORE_FOR_SEVERITY: Record<Severity, number> = {
  critical: 1,
  major: 2,
  moderate: 3,
  minor: 4,
};

/** Dimension score 1–5 derived from the worst severity among its smells (5 = none). */
export function scoreForSmells(smells: Smell[]): number {
  if (smells.length === 0) {
    return 5;
  }
  return Math.min(...smells.map((s) => SCORE_FOR_SEVERITY[s.severity]));
}

/** Mean of dimension scores, rounded to 1 decimal. */
export function overallFromDimensions(dimensions: DimensionResult[]): number {
  if (dimensions.length === 0) {
    return 5;
  }
  const mean =
    dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length;
  return Math.round(mean * 10) / 10;
}

/**
 * Return a copy of the detector result with every dimension score and the
 * overall score recomputed deterministically from the smell severities.
 * Ensures all five dimensions are present, in canonical order.
 */
export function recomputeScores(result: DetectorJSON): DetectorJSON {
  const byDimension = new Map<Dimension, DimensionResult>();
  for (const d of result.dimensions) {
    byDimension.set(d.dimension, d);
  }

  const dimensions: DimensionResult[] = DIMENSIONS.map((dimension) => {
    const smells = byDimension.get(dimension)?.smells ?? [];
    return { dimension, smells, score: scoreForSmells(smells) };
  });

  return {
    ...result,
    dimensions,
    overall_score: overallFromDimensions(dimensions),
  };
}
