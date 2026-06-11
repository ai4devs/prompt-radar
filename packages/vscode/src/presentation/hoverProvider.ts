import * as vscode from "vscode";
import type { SmellEntry } from "./diagnostics";

// Hover projection of analyzed smells (spec §12 retained, repointed to the
// PromptIndex). Shows name, severity, rationale, and remediation. Files without
// analyzed fragments simply have no entries, so nothing is shown.
export class SmellHoverProvider implements vscode.HoverProvider {
  private entriesByUri = new Map<string, SmellEntry[]>();

  setEntries(uri: vscode.Uri, entries: SmellEntry[]): void {
    this.entriesByUri.set(uri.toString(), entries);
  }

  clear(uri?: vscode.Uri): void {
    if (uri) {
      this.entriesByUri.delete(uri.toString());
    } else {
      this.entriesByUri.clear();
    }
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const entries = this.entriesByUri.get(document.uri.toString());
    if (!entries) {
      return undefined;
    }
    const matching = entries.filter((e) => e.range.contains(position));
    if (matching.length === 0) {
      return undefined;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    matching.forEach((entry, i) => {
      if (i > 0) {
        md.appendMarkdown("\n\n---\n\n");
      }
      const s = entry.smell;
      md.appendMarkdown(`**${s.name}**  \`${s.severity}\`\n\n`);
      md.appendMarkdown(`${s.rationale}`);
      if (s.remediation) {
        md.appendMarkdown(`\n\n💡 ${s.remediation}`);
      }
    });
    return new vscode.Hover(md);
  }
}
