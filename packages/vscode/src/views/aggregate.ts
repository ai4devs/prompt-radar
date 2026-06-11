import { DIMENSIONS, type Dimension, type Severity } from "../detector/types";
import type { Fragment } from "../model/types";

// Workspace aggregate (spec §5.1, confirmation #4): means computed over ANALYZED
// fragments only; counts include all detected so the card can show completeness
// ("+K pending") instead of silently misleading.
export interface Aggregate {
  detected: number;
  analyzed: number; // real prompts analyzed (excludes "not a prompt")
  pending: number;
  failed: number;
  notPrompt: number; // analyzed but the LLM judged it not a prompt
  dimensionMeans: Record<Dimension, number | null>;
  overall: number | null;
  severityCounts: Record<Severity, number>;
}

export function computeAggregate(fragments: Fragment[]): Aggregate {
  const sums = zeroDimensions();
  const counts = zeroDimensions();
  const severityCounts: Record<Severity, number> = {
    critical: 0,
    major: 0,
    moderate: 0,
    minor: 0,
  };

  let analyzed = 0;
  let failed = 0;
  let notPrompt = 0;

  for (const fragment of fragments) {
    if (fragment.failed) {
      failed++;
      continue;
    }
    const output = fragment.toolOutput;
    if (!output) {
      continue; // pending
    }
    // "not a prompt" is excluded from quality metrics so it doesn't inflate the
    // means toward 5 (it would otherwise report all dimensions = 5).
    if (output.artifact_type === "not_a_prompt") {
      notPrompt++;
      continue;
    }
    analyzed++;
    for (const dim of output.dimensions) {
      sums[dim.dimension] += dim.score;
      counts[dim.dimension] += 1;
      for (const smell of dim.smells) {
        severityCounts[smell.severity] += 1;
      }
    }
  }

  const dimensionMeans = {} as Record<Dimension, number | null>;
  let overallSum = 0;
  let overallCount = 0;
  for (const dim of DIMENSIONS) {
    const mean = counts[dim] > 0 ? round1(sums[dim] / counts[dim]) : null;
    dimensionMeans[dim] = mean;
    if (mean !== null) {
      overallSum += mean;
      overallCount += 1;
    }
  }

  return {
    detected: fragments.length,
    analyzed,
    pending: fragments.length - analyzed - failed - notPrompt,
    failed,
    notPrompt,
    dimensionMeans,
    overall: overallCount > 0 ? round1(overallSum / overallCount) : null,
    severityCounts,
  };
}

function zeroDimensions(): Record<Dimension, number> {
  return {
    formatting: 0,
    reliability: 0,
    efficiency: 0,
    security: 0,
    safety: 0,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
