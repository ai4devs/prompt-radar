import * as vscode from "vscode";
import { computeAggregate } from "./aggregate";
import { documentRangeForSmell } from "../presentation/diagnostics";
import { DIMENSIONS, type Dimension } from "../detector/types";
import type { PromptIndexStore } from "../model/PromptIndexStore";
import type { ResponseLogStore } from "../model/ResponseLogStore";
import type { Fragment } from "../model/types";
import type { Logger } from "../util/logger";
import type {
  RenderPayload,
  WebviewMessage,
  WorkspaceDimEntry,
} from "../webview/protocol";

// The radar webview panel (spec §5.2). One panel instance, opened from three
// places: right-click Analyze Selection, a tree fragment click, and the
// workspace summary card. Hosts the interactive smell review.
export class RadarPanel implements vscode.Disposable {
  static readonly viewType = "promptRadar.radar";

  private panel: vscode.WebviewPanel | undefined;
  private current: { mode: "fragment"; fragmentId: string } | { mode: "workspace" } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: PromptIndexStore,
    private readonly responses: ResponseLogStore,
    private readonly logger: Logger
  ) {
    // Re-render when the index changes (e.g. analysis completes). We deliberately
    // do NOT re-render on responseLog changes so an in-progress rationale the
    // user is typing in the webview is never clobbered.
    this.disposables.push(this.index.onDidChange(() => this.postRender()));
  }

  showFragment(fragmentId: string): void {
    this.current = { mode: "fragment", fragmentId };
    this.ensurePanel("Prompt Radar");
    this.postRender();
  }

  showWorkspace(): void {
    this.current = { mode: "workspace" };
    this.ensurePanel("Prompt Radar — Workspace");
    this.postRender();
  }

  private ensurePanel(title: string): void {
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      RadarPanel.viewType,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      }
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage | { type: "ready" }) => this.onMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      this.disposables
    );
  }

  private currentFragment(): Fragment | undefined {
    if (this.current?.mode === "fragment") {
      return this.index.get(this.current.fragmentId);
    }
    return undefined;
  }

  // Per-dimension breakdown for the workspace dashboard: which analyzed prompts
  // have smells in each dimension (clickable to drill in).
  private workspaceByDimension(): Record<Dimension, WorkspaceDimEntry[]> {
    const byDim = {} as Record<Dimension, WorkspaceDimEntry[]>;
    for (const dim of DIMENSIONS) {
      byDim[dim] = [];
    }
    for (const fragment of this.index.all()) {
      if (!fragment.toolOutput) {
        continue;
      }
      for (const d of fragment.toolOutput.dimensions) {
        if (d.smells.length === 0) {
          continue;
        }
        byDim[d.dimension].push({
          fragmentId: fragment.id,
          file: fragment.file,
          line: fragment.span.line_start + 1,
          score: d.score,
          smells: d.smells.map((s) => ({ name: s.name, severity: s.severity })),
        });
      }
    }
    return byDim;
  }

  private postRender(): void {
    if (!this.panel || !this.current) {
      return;
    }
    const consent = vscode.workspace
      .getConfiguration("promptRadar")
      .get<boolean>("research.consent", false);

    let payload: RenderPayload;
    if (this.current.mode === "workspace") {
      const agg = computeAggregate(this.index.all());
      payload = {
        mode: "workspace",
        dimensionMeans: agg.dimensionMeans,
        overall: agg.overall,
        severityCounts: agg.severityCounts,
        detected: agg.detected,
        analyzed: agg.analyzed,
        notPrompt: agg.notPrompt,
        consent,
        byDimension: this.workspaceByDimension(),
      };
    } else {
      const fragment = this.currentFragment();
      if (!fragment) {
        return;
      }
      payload = {
        mode: "fragment",
        fragment: {
          id: fragment.id,
          file: fragment.file,
          artifactText: fragment.artifactText,
          lineStart: fragment.span.line_start,
        },
        detector: fragment.toolOutput ?? null,
        failed: !!fragment.failed,
        responses: this.responses.responsesFor(fragment.id),
        missedSmells: this.responses.missedSmellsFor(fragment.id),
        consent,
      };
    }
    void this.panel.webview.postMessage({ type: "render", payload });
  }

  private onMessage(msg: WebviewMessage | { type: "ready" }): void {
    if (msg.type === "ready") {
      this.postRender();
      return;
    }
    if (msg.type === "export") {
      void vscode.commands.executeCommand("promptRadar.exportSessionLog");
      return;
    }
    if (msg.type === "revealFragment") {
      // From the workspace dashboard: open the file in the editor but keep the
      // workspace radar/list in the panel.
      void this.revealFragment(msg.fragmentId);
      return;
    }

    const fragment = this.currentFragment();
    if (!fragment) {
      return;
    }

    switch (msg.type) {
      case "response":
        this.responses.setResponse(fragment.id, {
          smellId: msg.smellId,
          decision: msg.decision,
          rationale: msg.rationale,
          shownAt: msg.shownAt,
        });
        break;
      case "jumpTo":
        void this.jumpTo(fragment, msg.evidence, msg.char_start, msg.char_end);
        break;
      case "missedSmell":
        this.responses.addMissedSmell(fragment.id, {
          dimension: msg.dimension,
          name: msg.name,
          severity: msg.severity,
          rationale: msg.rationale,
          span: this.missedSpanFromSelection(fragment),
          addedAt: new Date().toISOString(),
        });
        break;
    }
  }

  // Reveal a fragment in the editor without changing the panel (used by the
  // workspace dashboard links — stay on the list).
  private async revealFragment(id: string): Promise<void> {
    const fragment = this.index.get(id);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!fragment || !root) {
      return;
    }
    try {
      const uri = vscode.Uri.joinPath(root, fragment.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
      });
      const start = doc.positionAt(fragment.span.char_start);
      const end = doc.positionAt(fragment.span.char_end);
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(
        new vscode.Range(start, end),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
    } catch (err) {
      this.logger.verbose(
        `revealFragment failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Reveal the editor at the smell's evidence. LLM char offsets are unreliable,
  // so we locate the verbatim evidence text in the fragment (offsets are only a
  // fallback) — same logic as the inline diagnostics.
  private async jumpTo(
    fragment: Fragment,
    evidence: string,
    artifactStart: number,
    artifactEnd: number
  ): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return;
    }
    try {
      const uri = vscode.Uri.joinPath(root, fragment.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const range =
        documentRangeForSmell(doc, fragment, {
          evidence,
          location: { char_start: artifactStart, char_end: artifactEnd, line: null },
        }) ??
        new vscode.Range(
          doc.positionAt(fragment.span.char_start + artifactStart),
          doc.positionAt(fragment.span.char_start + artifactEnd)
        );
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
      });
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
    } catch (err) {
      this.logger.verbose(
        `radar jumpTo failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Missed-smell span: use the current editor selection if it lies inside the
  // fragment; otherwise default to the whole fragment. (Design choice recorded
  // in NOTES.md.)
  private missedSpanFromSelection(fragment: Fragment): {
    char_start: number;
    char_end: number;
  } {
    const editor = vscode.window.activeTextEditor;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (editor && root) {
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      if (rel === fragment.file && !editor.selection.isEmpty) {
        const selStart = editor.document.offsetAt(editor.selection.start);
        const selEnd = editor.document.offsetAt(editor.selection.end);
        const base = fragment.span.char_start;
        if (selStart >= base && selEnd <= fragment.span.char_end) {
          return { char_start: selStart - base, char_end: selEnd - base };
        }
      }
    }
    return { char_start: 0, char_end: fragment.artifactText.length };
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "radar.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https:`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Prompt Radar</title>
<style nonce="${nonce}">${PANEL_CSS}</style>
</head><body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

const PANEL_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-size: 13px; margin: 0; padding: 0 18px 36px; }
#root { max-width: 760px; margin: 0 auto; }
.score { font-size: 50px; font-weight: 800; line-height: 1; text-align: center; margin-top: 22px; letter-spacing: -0.02em; }
.score small { display:block; font-size: 10px; font-weight: 500; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.14em; margin-top: 6px; }
#chart-wrap { max-width: 360px; margin: 10px auto 4px; }
.summary { opacity: 0.82; line-height: 1.55; text-align: center; margin: 10px auto 16px; max-width: 540px; }
.consent-banner { background: rgba(234,179,8,0.12); border: 1px solid rgba(234,179,8,0.4); color:#d4a017; border-radius: 8px; padding: 7px 12px; font-size: 11px; margin: 12px 0; text-align: center; }

/* dimension sections */
.dim-section { border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.22)); border-radius: 10px; margin: 10px 0; overflow: hidden; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.04)); }
.dim-section > summary { cursor: pointer; padding: 11px 14px; font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 9px; list-style: none; }
.dim-section > summary:hover { background: rgba(127,127,127,0.09); }
.dim-section > summary::-webkit-details-marker { display: none; }
.dim-section > summary::before { content: "›"; font-size: 15px; opacity: 0.5; display:inline-block; transition: transform .15s ease; }
.dim-section[open] > summary::before { transform: rotate(90deg); }
.dim-section > summary > span:first-of-type { flex: 1; }
.dim-name { cursor: help; }
.dim-body { padding: 2px 12px 12px; }
.dim-agg { font-size: 11px; opacity: 0.6; margin: 2px 0 8px; }
.ws-frag { border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.18)); border-radius: 8px; padding: 8px 10px; margin: 6px 0; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05)); }
.ws-frag-head { display:flex; align-items:center; gap:8px; margin-bottom: 4px; }
.ws-link { flex:1; cursor:pointer; color: var(--vscode-textLink-foreground); font-size: 12px; word-break: break-all; }
.ws-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
.ws-smell { display:flex; align-items:center; gap:8px; margin: 3px 0; }
.ws-smell-name { font-size: 12px; opacity: 0.85; }
.dim-score { font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 999px; }
.s-good { background: rgba(34,197,94,0.16); color:#22c55e; } .s-mid { background: rgba(234,179,8,0.16); color:#d4a017; } .s-bad { background: rgba(239,68,68,0.16); color:#ef4444; }

/* smell cards */
.smell { position: relative; margin: 10px 12px; padding: 12px 14px; border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.18)); border-left: 3px solid rgba(127,127,127,0.45); border-radius: 9px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05)); transition: background .12s ease, border-color .12s ease; }
.smell:hover { background: rgba(127,127,127,0.09); }
.sevcard-critical { border-left-color:#ef4444; } .sevcard-major { border-left-color:#f59e0b; }
.sevcard-moderate { border-left-color:#eab308; } .sevcard-minor { border-left-color:#60a5fa; }
.smell-head { display:flex; align-items:center; gap:9px; }
.sev { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; padding: 2px 9px; border-radius: 999px; flex-shrink: 0; }
.sev-critical { background: rgba(239,68,68,0.2); color:#f87171; } .sev-major { background: rgba(245,158,11,0.2); color:#fbbf24; }
.sev-moderate { background: rgba(234,179,8,0.18); color:#facc15; } .sev-minor { background: rgba(96,165,250,0.2); color:#93c5fd; }
/* light themes: pale-on-tint badge text is washed out, so use darker, saturated
   variants. Dark mode keeps the colors above. */
body.pr-light .sev-critical { color:#b91c1c; } body.pr-light .sev-major { color:#b45309; }
body.pr-light .sev-moderate { color:#a16207; } body.pr-light .sev-minor { color:#1d4ed8; }
body.pr-light .s-good { color:#15803d; } body.pr-light .s-mid { color:#a16207; } body.pr-light .s-bad { color:#b91c1c; }
.smell-name { font-weight: 600; flex: 1; font-size: 13px; }
.conf { font-size: 10px; opacity: 0.8; padding: 2px 8px; border-radius: 999px; background: rgba(127,127,127,0.18); flex-shrink: 0; }
.smell-desc { opacity: 0.85; line-height: 1.55; margin: 8px 0; }
.evidence { display:block; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.28)); border-left: 2px solid rgba(127,127,127,0.55); padding: 6px 10px; border-radius: 5px; white-space: pre-wrap; word-break: break-word; cursor: pointer; margin-top: 4px; transition: border-color .12s ease; }
.evidence:hover { border-left-color:#60a5fa; }
.detail-toggle { font-size: 11px; opacity: 0.65; cursor: pointer; margin-top: 10px; user-select:none; }
.detail-toggle:hover { opacity: 0.9; }
.detail-body { font-size: 12px; opacity: 0.82; line-height: 1.55; margin-top: 6px; padding-left: 10px; border-left: 2px solid rgba(127,127,127,0.3); }
.detail-body p { margin: 4px 0; }

/* reviewer assessment (bottom of card) */
.review { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--vscode-widget-border, rgba(127,127,127,0.3)); }
.review-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.5; margin-bottom: 8px; }
.radios { display:flex; flex-wrap:wrap; gap: 8px; }
.radios label.rc { cursor:pointer; display:inline-flex; align-items:center; font-size: 12px; padding: 4px 14px; border-radius: 999px; border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.4)); background: rgba(127,127,127,0.07); transition: all .12s ease; }
.radios label.rc:hover { background: rgba(127,127,127,0.16); }
.radios label.rc input { position:absolute; opacity:0; width:0; height:0; }
.radios label.rc-agree:has(input:checked) { background: rgba(34,197,94,0.18); border-color:#22c55e; color:#22c55e; font-weight:600; }
.radios label.rc-disagree:has(input:checked) { background: rgba(239,68,68,0.18); border-color:#ef4444; color:#ef4444; font-weight:600; }
.radios label.rc-unsure:has(input:checked) { background: rgba(234,179,8,0.18); border-color:#d4a017; color:#d4a017; font-weight:600; }
.rationale { width:100%; margin-top:8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, rgba(127,127,127,0.3)); border-radius:6px; padding:6px 8px; font-family: inherit; font-size: 12px; resize: vertical; }
.no-smells { opacity: 0.55; padding: 10px 14px; font-size: 12px; }
button.action { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none; border-radius:6px; padding:7px 14px; cursor:pointer; font-size:12px; font-weight:500; }
button.action:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
button.action.secondary { background: transparent; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.4)); color: var(--vscode-foreground); }
.footer { display:flex; gap:10px; justify-content:center; margin-top:20px; }
.missed-form { border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.3)); border-radius:8px; padding:12px 14px; margin-top:10px; display:none; flex-direction:column; gap:7px; }
.missed-form.open { display:flex; }
.missed-form input, .missed-form select, .missed-form textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, rgba(127,127,127,0.3)); border-radius:6px; padding:6px 8px; font-family:inherit; font-size:12px; }
.placeholder { opacity: 0.55; text-align:center; padding: 44px 0; }
.na-card { text-align:center; padding: 28px 0 8px; }
.na-badge { display:inline-block; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.4)); border-radius: 999px; padding: 4px 14px; }
.na-card .summary { margin-top: 12px; }
h3.section-title { margin: 20px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.6; }
`;

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
