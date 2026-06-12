// Shared message protocol between the RadarPanel host and the webview bundle.
// Imported with `import type` on both sides so nothing leaks into the bundle.
import type { DetectorJSON } from "../detector/schema";
import type { Dimension, Severity } from "../detector/types";
import type { Decision, MissedSmell, Response } from "../model/types";

export interface FragmentView {
  id: string;
  file: string;
  artifactText: string;
  lineStart: number;
}

export interface RenderFragmentPayload {
  mode: "fragment";
  fragment: FragmentView;
  detector: DetectorJSON | null;
  failed: boolean;
  responses: Response[];
  missedSmells: MissedSmell[];
}

export interface WorkspaceDimEntry {
  fragmentId: string;
  file: string;
  line: number;
  score: number;
  smells: { name: string; severity: Severity }[];
}

export interface RenderWorkspacePayload {
  mode: "workspace";
  dimensionMeans: Record<Dimension, number | null>;
  overall: number | null;
  severityCounts: Record<Severity, number>;
  detected: number;
  analyzed: number;
  notPrompt: number;
  byDimension: Record<Dimension, WorkspaceDimEntry[]>;
}

export type RenderPayload = RenderFragmentPayload | RenderWorkspacePayload;

export type HostMessage = { type: "render"; payload: RenderPayload };

export type WebviewMessage =
  | { type: "ready" }
  | {
      type: "response";
      smellId: string;
      decision: Decision;
      rationale?: string;
      shownAt: string;
    }
  | { type: "jumpTo"; evidence: string; char_start: number; char_end: number }
  | { type: "revealFragment"; fragmentId: string }
  | {
      type: "missedSmell";
      dimension: Dimension;
      name: string;
      severity: Severity;
      rationale?: string;
    };
