import * as vscode from "vscode";
import type { Fragment } from "../model/types";
import type { PromptIndexStore } from "../model/PromptIndexStore";
import type { ResponseLogStore } from "../model/ResponseLogStore";

export type TreeNode =
  | { kind: "file"; file: string }
  | { kind: "fragment"; fragment: Fragment };

// Detected Prompts tree (spec §5.1): file → fragment, with score / smell-count /
// reviewed-N/M badges. Clicking a fragment fires promptRadar.openFragment.
export class PromptsTreeDataProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly index: PromptIndexStore,
    private readonly responses: ResponseLogStore
  ) {
    this.disposables.push(
      this.index.onDidChange(() => this.emitter.fire()),
      this.responses.onDidChange(() => this.emitter.fire())
    );
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.index
        .files()
        .sort((a, b) => a.localeCompare(b))
        .map((file) => ({ kind: "file" as const, file }));
    }
    if (element.kind === "file") {
      return this.index
        .forFile(element.file)
        .sort((a, b) => a.span.char_start - b.span.char_start)
        .map((fragment) => ({ kind: "fragment" as const, fragment }));
    }
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "file") {
      const fragments = this.index.forFile(node.file);
      const analyzed = fragments.filter((f) => f.toolOutput).length;
      const item = new vscode.TreeItem(
        basename(node.file),
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${dirname(node.file)}  ·  ${analyzed}/${fragments.length}`;
      item.resourceUri = vscode.Uri.file(node.file);
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = "promptRadar.file";
      item.tooltip = node.file;
      return item;
    }

    const f = node.fragment;
    const item = new vscode.TreeItem(
      labelFor(f),
      vscode.TreeItemCollapsibleState.None
    );
    item.description = describeFragment(f, this.reviewed(f));
    item.tooltip = new vscode.MarkdownString(
      `**Line ${f.span.line_start + 1}** · confidence ${Math.round(
        f.confidence * 100
      )}%\n\n\`\`\`\n${truncate(f.artifactText, 400)}\n\`\`\``
    );
    item.iconPath = iconFor(f);
    item.contextValue = "promptRadar.fragment";
    item.command = {
      command: "promptRadar.openFragment",
      title: "Open in Prompt Radar",
      arguments: [f.id],
    };
    return item;
  }

  /** reviewed N / total M smells for a fragment. */
  private reviewed(f: Fragment): { n: number; m: number } {
    if (!f.toolOutput) {
      return { n: 0, m: 0 };
    }
    const smellIds = f.toolOutput.dimensions.flatMap((d) =>
      d.smells.map((s) => s.id)
    );
    const responded = new Set(this.responses.responsesFor(f.id).map((r) => r.smellId));
    const n = smellIds.filter((id) => responded.has(id)).length;
    return { n, m: smellIds.length };
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

function labelFor(f: Fragment): string {
  const firstLine = f.artifactText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return truncate(firstLine ?? `Fragment @ line ${f.span.line_start + 1}`, 60);
}

function describeFragment(f: Fragment, reviewed: { n: number; m: number }): string {
  if (f.failed) {
    return "⚠ analysis failed";
  }
  if (!f.toolOutput) {
    return "pending";
  }
  if (f.toolOutput.artifact_type === "not_a_prompt") {
    return "N/A · not a prompt";
  }
  const smellCount = f.toolOutput.dimensions.reduce(
    (n, d) => n + d.smells.length,
    0
  );
  return `${f.toolOutput.overall_score}/5 · ${smellCount} smell${
    smellCount === 1 ? "" : "s"
  } · ${reviewed.n}/${reviewed.m} reviewed`;
}

function iconFor(f: Fragment): vscode.ThemeIcon {
  if (f.failed) {
    return new vscode.ThemeIcon(
      "error",
      new vscode.ThemeColor("errorForeground")
    );
  }
  if (!f.toolOutput) {
    return new vscode.ThemeIcon("circle-outline");
  }
  if (f.toolOutput.artifact_type === "not_a_prompt") {
    return new vscode.ThemeIcon(
      "circle-slash",
      new vscode.ThemeColor("descriptionForeground")
    );
  }
  // Worst dimension, not the mean — so a single critical smell shows a red dot
  // (consistent with the radar color).
  const worst = Math.min(...f.toolOutput.dimensions.map((d) => d.score));
  const color =
    worst >= 3.5
      ? "charts.green"
      : worst >= 2
        ? "charts.yellow"
        : "charts.red";
  return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(color));
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "" : p.slice(0, i);
}
