import * as vscode from "vscode";
import { buildInlineForDocument } from "./diagnostics";
import { SmellHoverProvider } from "./hoverProvider";
import type { PromptIndexStore } from "../model/PromptIndexStore";

// Coordinates the inline surfaces (diagnostics + hover) as pure read-only
// projections of the PromptIndex. Refreshes on index changes, document opens,
// and changes to the promptRadar.inline.* settings. No LLM calls.
export class InlineController implements vscode.Disposable {
  private readonly diagnostics =
    vscode.languages.createDiagnosticCollection("promptRadar");
  private readonly hover = new SmellHoverProvider();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly index: PromptIndexStore) {
    this.disposables.push(
      this.diagnostics,
      vscode.languages.registerHoverProvider({ scheme: "file" }, this.hover),
      this.index.onDidChange(() => this.refreshAll()),
      vscode.workspace.onDidOpenTextDocument((doc) => this.refreshDocument(doc)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("promptRadar.inline")) {
          this.refreshAll();
        }
      })
    );
  }

  private settings(): { diag: boolean; hover: boolean } {
    const cfg = vscode.workspace.getConfiguration("promptRadar");
    return {
      diag: cfg.get<boolean>("inline.diagnostics", true),
      hover: cfg.get<boolean>("inline.hover", true),
    };
  }

  refreshAll(): void {
    this.diagnostics.clear();
    this.hover.clear();
    for (const doc of vscode.workspace.textDocuments) {
      this.refreshDocument(doc);
    }
  }

  refreshDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file") {
      return;
    }
    const rel = vscode.workspace.asRelativePath(document.uri, false);
    const fragments = this.index.forFile(rel);
    if (fragments.length === 0) {
      this.diagnostics.delete(document.uri);
      this.hover.clear(document.uri);
      return;
    }
    const { diag, hover } = this.settings();
    const { entries, diagnostics } = buildInlineForDocument(document, fragments);
    this.diagnostics.set(document.uri, diag ? diagnostics : []);
    this.hover.setEntries(document.uri, hover ? entries : []);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
