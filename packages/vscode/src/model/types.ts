import type { ArtifactType, Dimension, Severity } from "../detector/types";
import type { DetectorJSON } from "../detector/schema";

export type Decision = "agree" | "disagree" | "unsure";

/**
 * Per-occurrence response key. A smell's catalog id is NOT unique within a
 * fragment (the detector can flag the same catalog smell at two sites), so
 * responses are keyed by dimension + position + catalog id. Stored in
 * `Response.smellId`. Used by both the webview and the tree provider so the
 * reviewed-N/M counts and the cards always agree.
 */
export function smellResponseKey(
  dimension: string,
  index: number,
  smellId: string
): string {
  return `${dimension}#${index}:${smellId}`;
}

export interface FragmentSpan {
  char_start: number;
  char_end: number;
  line_start: number;
  line_end: number;
}

// A prompt fragment discovered by the scanner (or an ad-hoc selection). Mirrors
// spec §8.1, plus `confidence` (heuristic detection strength, see NOTES.md
// "Deviations from brief") and `failed` (detector error marker).
export interface Fragment {
  id: string; // sha256(file + char_start + char_end)
  file: string; // workspace-relative path
  span: FragmentSpan;
  artifactType: ArtifactType;
  artifactText: string; // verbatim
  artifactTextSha256: string;
  confidence: number; // 0–1, scanner detection confidence
  toolOutput?: DetectorJSON; // populated after analysis
  model?: string; // model that produced toolOutput (best effort)
  scannedAt: string; // ISO
  analyzedAt?: string; // ISO
  failed?: boolean; // detector returned malformed output
}

export interface Response {
  smellId: string; // per-occurrence key, see smellResponseKey()
  decision: Decision;
  rationale?: string;
  shownAt: string; // ISO — when the smell was first rendered
  respondedAt: string; // ISO — when this response was recorded
  changedCount: number; // number of times the user revised the response
}

export interface MissedSmell {
  dimension: Dimension;
  name: string;
  span: { char_start: number; char_end: number };
  severity: Severity;
  rationale?: string;
  addedAt: string; // ISO
}

// In-memory index of all fragments (persisted as index.json).
export interface PromptIndex {
  fragments: Map<string, Fragment>;
  byFile: Map<string, string[]>; // file → fragment ids
}

// In-memory session log (persisted as responses.json): the session identity
// and the user's responses/missed smells.
export interface ResponseLog {
  sessionId: string;
  startedAt: string;
  responses: Map<string /* fragmentId */, Map<string /* smellId */, Response>>;
  missedSmells: Map<string /* fragmentId */, MissedSmell[]>;
}
