import * as vscode from "vscode";
import { CATALOG_VERSION, DIMENSIONS, type Dimension } from "../detector/types";
import {
  bannerActionForKind,
  type ProviderErrorKind,
} from "../llm/LLMProvider";
import type { PromptIndexStore } from "../model/PromptIndexStore";
import type { ResponseLogStore } from "../model/ResponseLogStore";
import { computeAggregate, type Aggregate } from "./aggregate";

const SETTINGS_QUERY = "@ext:ai4devs.prompt-radar";

const SHORT_LABELS: Record<Dimension, string> = {
  formatting: "Fmt",
  reliability: "Rel",
  efficiency: "Eff",
  security: "Sec",
  safety: "Saf",
};

// Workspace Summary view (spec §5.1). Aggregate radar over analyzed-only with
// explicit completeness states + "+K pending" (confirmation #4). Hosts the
// provider-error banner (spec §7.3). Rendered host-side as static SVG; a small
// inline script only forwards clicks.
export class SummaryViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "promptRadar.summary";

  private view: vscode.WebviewView | undefined;
  private error: { kind: ProviderErrorKind; message: string } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: PromptIndexStore,
    private readonly responses: ResponseLogStore
  ) {
    this.disposables.push(
      this.index.onDidChange(() => this.render()),
      this.responses.onDidChange(() => this.render())
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.onDidReceiveMessage((msg: { type: string; action?: string }) => {
      if (msg.type === "open") {
        void vscode.commands.executeCommand("promptRadar.openWorkspaceDashboard");
      } else if (msg.type === "action") {
        if (msg.action === "openSettings") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            SETTINGS_QUERY
          );
          this.clearError();
        } else if (msg.action === "retry") {
          this.clearError();
        }
      }
    });
    this.render();
  }

  showError(kind: ProviderErrorKind, message: string): void {
    this.error = { kind, message };
    this.render();
  }

  clearError(): void {
    this.error = undefined;
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    const aggregate = computeAggregate(this.index.all());
    this.view.webview.html = this.html(this.view.webview, aggregate);
  }

  private html(webview: vscode.Webview, agg: Aggregate): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Worst severity present across the workspace — a single critical turns the
    // card red (consistent with the fragment radar), instead of the mean.
    const color =
      agg.analyzed === 0
        ? "var(--vscode-descriptionForeground)"
        : agg.severityCounts.critical > 0
          ? "#ef4444"
          : agg.severityCounts.major > 0 || agg.severityCounts.moderate > 0
            ? "#eab308"
            : "#22c55e";

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; padding: 8px; }
  .banner { border-radius: 4px; padding: 6px 8px; margin-bottom: 8px; font-size: 11px; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  .banner.err { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); }
  .banner button { font-size: 11px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 2px 8px; }
  .card { cursor: pointer; }
  .score { font-size: 34px; font-weight: 700; line-height: 1; color: ${color}; text-align: center; }
  .score small { font-size: 10px; font-weight: 400; opacity: 0.6; display:block; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 3px; }
  .radar { display: block; margin: 6px auto; }
  .radar .grid { stroke: var(--vscode-foreground); opacity: 0.18; fill: none; }
  .radar .axis { stroke: var(--vscode-foreground); opacity: 0.26; }
  .state { text-align: center; opacity: 0.75; margin: 4px 0 8px; }
  .pending { opacity: 0.55; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; margin-bottom: 6px; }
  .chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); }
  .chip.zero { opacity: 0.35; }
  .chip.critical { color: #ef4444; } .chip.major { color: #f59e0b; }
  .chip.moderate { color: #eab308; } .chip.minor { color: #60a5fa; }
  .meta { text-align: center; font-size: 10px; opacity: 0.45; }
  .empty { text-align: center; opacity: 0.6; padding: 16px 4px; }
</style>
</head><body>
${this.bannerHtml()}
${agg.detected === 0 ? emptyHtml() : this.cardHtml(agg, color)}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const card = document.getElementById('card');
  if (card) card.addEventListener('click', () => vscode.postMessage({ type: 'open' }));
  document.querySelectorAll('[data-action]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'action', action: b.getAttribute('data-action') }); }));
</script>
</body></html>`;
  }

  private bannerHtml(): string {
    if (!this.error) {
      return "";
    }
    const action = bannerActionForKind(this.error.kind);
    const button =
      action === "openSettings"
        ? `<button data-action="openSettings">Open Settings</button>`
        : action === "retry"
          ? `<button data-action="retry">Dismiss</button>`
          : "";
    return `<div class="banner err"><span>${escapeHtml(
      `${this.error.kind}: ${this.error.message}`
    )}</span>${button}</div>`;
  }

  private cardHtml(agg: Aggregate, color: string): string {
    return `<div class="card" id="card" title="Open workspace dashboard">
  <div class="score">${agg.overall ?? "–"}<small>workspace score</small></div>
  ${radarSvg(agg.dimensionMeans, color)}
  <div class="state">${stateLine(agg)}</div>
  <div class="chips">${chipsHtml(agg)}</div>
  <div class="meta">catalog v${CATALOG_VERSION}${
    agg.failed > 0 ? ` · ${agg.failed} failed` : ""
  }</div>
</div>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function stateLine(agg: Aggregate): string {
  const extra: string[] = [];
  if (agg.pending > 0) {
    extra.push(`<span class="pending">${agg.pending} pending</span>`);
  }
  if (agg.notPrompt > 0) {
    extra.push(`<span class="pending">${agg.notPrompt} not a prompt</span>`);
  }
  if (agg.failed > 0) {
    extra.push(`<span class="pending">${agg.failed} failed</span>`);
  }
  const suffix = extra.length ? ` · ${extra.join(" · ")}` : "";
  if (agg.analyzed === 0) {
    return `${agg.detected} fragment${agg.detected === 1 ? "" : "s"} detected · 0 analyzed${suffix}`;
  }
  return `${agg.analyzed} of ${agg.detected} analyzed${suffix}`;
}

function chipsHtml(agg: Aggregate): string {
  const order: Array<keyof Aggregate["severityCounts"]> = [
    "critical",
    "major",
    "moderate",
    "minor",
  ];
  return order
    .map((sev) => {
      const n = agg.severityCounts[sev];
      return `<span class="chip ${sev} ${n === 0 ? "zero" : ""}">${n} ${sev}</span>`;
    })
    .join("");
}

function emptyHtml(): string {
  return `<div class="empty">No prompts detected.<br/>Run <b>Scan Workspace</b> to begin.</div>`;
}

/** Static pentagon radar. Null means (0 analyzed) draw as an empty hull. */
function radarSvg(
  means: Record<Dimension, number | null>,
  color: string
): string {
  const size = 168;
  const cx = size / 2;
  const cy = size / 2;
  const R = 56;
  const angle = (i: number): number => -Math.PI / 2 + (i * 2 * Math.PI) / 5;
  const point = (value: number, i: number): [number, number] => {
    const r = (R * value) / 5;
    return [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
  };

  const grid = [1, 2, 3, 4, 5]
    .map((ring) => {
      const pts = DIMENSIONS.map((_, i) => point(ring, i))
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" ");
      return `<polygon class="grid" points="${pts}" stroke-width="1"/>`;
    })
    .join("");

  const axes = DIMENSIONS.map((_, i) => {
    const [x, y] = point(5, i);
    return `<line class="axis" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(
      1
    )}" stroke-width="1"/>`;
  }).join("");

  const labels = DIMENSIONS.map((dim, i) => {
    const [x, y] = point(6.1, i);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(
      1
    )}" fill="var(--vscode-descriptionForeground)" font-size="9" text-anchor="middle" dominant-baseline="middle">${
      SHORT_LABELS[dim]
    }</text>`;
  }).join("");

  const dataPts = DIMENSIONS.map((dim, i) => point(means[dim] ?? 0, i))
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const dataPolygon = `<polygon points="${dataPts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2"/>`;

  // A dot per dimension, colored by that dimension's mean (critical → red).
  const dots = DIMENSIONS.map((dim, i) => {
    const mean = means[dim];
    if (mean === null) {
      return "";
    }
    const [x, y] = point(mean, i);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${colorForScore(mean)}" stroke="var(--vscode-editor-background)" stroke-width="0.8"/>`;
  }).join("");

  return `<svg class="radar" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${grid}${axes}${dataPolygon}${dots}${labels}</svg>`;
}

function colorForScore(score: number): string {
  if (score >= 3.5) return "#22c55e";
  if (score >= 2) return "#eab308";
  return "#ef4444";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
