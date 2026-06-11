import * as vscode from "vscode";
import type { Severity } from "../detector/types";
import type { Smell } from "../detector/schema";
import type { Fragment } from "../model/types";

export interface SmellEntry {
  range: vscode.Range;
  fragment: Fragment;
  smell: Smell;
}

// Severity → diagnostic severity (confirmed mapping):
// critical/major → Error, moderate → Warning, minor → Information.
const SEVERITY_TO_DIAGNOSTIC: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  major: vscode.DiagnosticSeverity.Error,
  moderate: vscode.DiagnosticSeverity.Warning,
  minor: vscode.DiagnosticSeverity.Information,
};

/**
 * Resolve the editor range of a smell. The smell's `location` offsets are
 * relative to the fragment's artifact text; we add the fragment's document
 * offset. Falls back to searching for the verbatim evidence if the offsets
 * don't line up with the artifact text.
 */
export function documentRangeForSmell(
  document: vscode.TextDocument,
  fragment: Fragment,
  smell: Pick<Smell, "evidence" | "location">
): vscode.Range | undefined {
  const artifact = fragment.artifactText;
  let start = smell.location.char_start;
  let end = smell.location.char_end;

  const offsetsLookValid =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= artifact.length &&
    start < end &&
    (!smell.evidence || artifact.slice(start, end) === smell.evidence);

  if (!offsetsLookValid && smell.evidence) {
    const idx = artifact.indexOf(smell.evidence);
    if (idx !== -1) {
      start = idx;
      end = idx + smell.evidence.length;
    } else {
      return undefined;
    }
  } else if (!offsetsLookValid) {
    return undefined;
  }

  const base = fragment.span.char_start;
  return new vscode.Range(
    document.positionAt(base + start),
    document.positionAt(base + end)
  );
}

/** Build diagnostics + hover entries for every analyzed fragment in a document. */
export function buildInlineForDocument(
  document: vscode.TextDocument,
  fragments: Fragment[]
): { entries: SmellEntry[]; diagnostics: vscode.Diagnostic[] } {
  const entries: SmellEntry[] = [];
  const diagnostics: vscode.Diagnostic[] = [];

  for (const fragment of fragments) {
    if (!fragment.toolOutput) {
      continue; // unanalyzed fragments contribute nothing inline
    }
    for (const dimension of fragment.toolOutput.dimensions) {
      for (const smell of dimension.smells) {
        const range = documentRangeForSmell(document, fragment, smell);
        if (!range) {
          continue;
        }
        const diagnostic = new vscode.Diagnostic(
          range,
          `${smell.name}: ${smell.description}`,
          SEVERITY_TO_DIAGNOSTIC[smell.severity]
        );
        diagnostic.source = "Prompt Radar";
        diagnostic.code = smell.id;
        entries.push({ range, fragment, smell });
        diagnostics.push(diagnostic);
      }
    }
  }

  return { entries, diagnostics };
}
