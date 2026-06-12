import {
  Chart,
  RadarController,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from "chart.js";
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_DESCRIPTIONS,
  type Dimension,
} from "../detector/types";
import type { DimensionResult, Smell } from "../detector/schema";
import type { Severity } from "../detector/types";
import { smellResponseKey, type Decision } from "../model/types";
import type {
  RenderFragmentPayload,
  RenderPayload,
  RenderWorkspacePayload,
  WebviewMessage,
  WorkspaceDimEntry,
} from "./protocol";

Chart.register(
  RadarController,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
};
const vscode = acquireVsCodeApi();

let chart: Chart<"radar"> | null = null;
// shownAt[responseKey] = ISO time the smell was first rendered this session.
const shownAt = new Map<string, string>();

// Order for the collapsible dimension cards: Security first (it is the highest
// review priority), then the rest in their canonical order. The radar chart
// axes deliberately keep the canonical DIMENSIONS order so the pentagon still
// matches the sidebar Workspace Summary radar.
const SECTION_DIMENSIONS: Dimension[] = [
  "security",
  ...DIMENSIONS.filter((d) => d !== "security"),
];

// ── helpers ──────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function colorForScore(score: number | null): string {
  if (score === null) return "rgba(160,160,160,0.85)";
  if (score >= 3.5) return "#22c55e";
  if (score >= 2) return "#eab308";
  return "#ef4444";
}

// Workspace color follows the WORST-SEVERITY rule (a single critical turns it
// red), identical to the sidebar Workspace Summary card so the two radars never
// disagree. The mean overall score is shown as the number, not the color.
function workspaceColor(p: RenderWorkspacePayload): string {
  if (p.analyzed === 0) return "rgba(160,160,160,0.85)";
  if (p.severityCounts.critical > 0) return "#ef4444";
  if (p.severityCounts.major > 0 || p.severityCounts.moderate > 0)
    return "#eab308";
  return "#22c55e";
}

function scoreClass(score: number): string {
  if (score >= 3.5) return "s-good";
  if (score >= 2) return "s-mid";
  return "s-bad";
}

// ── chart ────────────────────────────────────────────────────────────────────

function drawChart(
  scores: Array<number | null>,
  color: string,
  onLabelClick?: (dim: Dimension) => void
): void {
  const canvas = document.getElementById("radar-chart") as HTMLCanvasElement;
  if (!canvas) return;
  if (chart) {
    chart.destroy();
    chart = null;
  }
  // Each axis point is colored by its OWN dimension's score (same ranges as
  // everything else), so the per-dimension markers and the tooltip square follow
  // the most-critical rule: a critical dimension shows red.
  const pointColors = scores.map((s) => colorForScore(s));

  // Theme-aware chrome derived from the editor foreground/background (always the
  // right contrast in either theme): grid/axis/labels tint with the foreground,
  // the point halo matches the editor background.
  const [fr, fg, fb] = computedRgb("color", [204, 204, 204]);
  const [br, bg, bb] = computedRgb("backgroundColor", [30, 30, 30]);
  const gridColor = `rgba(${fr},${fg},${fb},0.18)`;
  const axisColor = `rgba(${fr},${fg},${fb},0.26)`;
  const labelColor = `rgba(${fr},${fg},${fb},0.9)`;
  const pointHalo = `rgb(${br},${bg},${bb})`;
  chart = new Chart(canvas, {
    type: "radar",
    data: {
      labels: DIMENSIONS.map((d) => DIMENSION_LABELS[d]),
      datasets: [
        {
          label: "Score",
          data: scores.map((s) => s ?? 0),
          backgroundColor: hexToRgba(color, 0.16),
          borderColor: color,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointHalo,
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      onClick: (_e, elements) => {
        if (onLabelClick && elements.length > 0) {
          onLabelClick(DIMENSIONS[elements[0].index]);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: () => "",
            label: (ctx) =>
              ` ${DIMENSION_LABELS[DIMENSIONS[ctx.dataIndex]]}: ${ctx.raw}/5`,
            labelColor: (ctx) => {
              const c = pointColors[ctx.dataIndex];
              return { borderColor: c, backgroundColor: c };
            },
          },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 5,
          ticks: { stepSize: 1, display: false },
          grid: { color: gridColor },
          angleLines: { color: axisColor },
          pointLabels: { color: labelColor, font: { size: 12 } },
        },
      },
    },
  });
}

// Read a *computed* color off <body> as an [r,g,b] triple. Unlike a custom
// property (which comes back as an unparsed, sometimes-empty string), computed
// `color`/`backgroundColor` are always returned as rgb()/rgba() by the browser —
// and body already sets both from --vscode-foreground / --vscode-editor-background.
function computedRgb(
  prop: "color" | "backgroundColor",
  fallback: [number, number, number]
): [number, number, number] {
  const m = getComputedStyle(document.body)[prop].match(/(\d+)\D+(\d+)\D+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fallback;
}

// Light vs dark from the editor background's luminance — a reliable signal that
// is always present (unlike body theme classes, which we can't depend on here).
function isLightTheme(): boolean {
  const [r, g, b] = computedRgb("backgroundColor", [30, 30, 30]);
  return r * 0.299 + g * 0.587 + b * 0.114 > 140;
}

function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith("#")) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── fragment render ──────────────────────────────────────────────────────────

function renderFragment(p: RenderFragmentPayload): void {
  const root = document.getElementById("root")!;
  root.innerHTML = "";

  if (!p.detector) {
    const msg = p.failed
      ? "Analysis failed for this fragment. See the Prompt Radar output channel."
      : "Analyzing this fragment…";
    root.appendChild(el("div", "placeholder", msg));
    return;
  }

  const det = p.detector;

  // Not a prompt → no score, no radar (it would otherwise report 5/5 and skew
  // the workspace metrics). Show N/A; the reviewer can still add a missed
  // smell.
  if (det.artifact_type === "not_a_prompt") {
    const na = el("div", "na-card");
    na.appendChild(el("div", "na-badge", "N/A — not a prompt"));
    na.appendChild(
      el(
        "p",
        "summary",
        det.summary ||
          "This artifact does not appear to contain a prompt, so it has no score and is excluded from the workspace metrics."
      )
    );
    root.appendChild(na);
    root.appendChild(buildMissedSmells(p));
    return;
  }

  // Color reflects the WORST dimension, not the mean — so a single critical
  // smell turns the radar red even when the average score is high.
  const worstScore = det.dimensions.length
    ? Math.min(...det.dimensions.map((d) => d.score))
    : det.overall_score;
  const color = colorForScore(worstScore);

  const score = el("div", "score");
  score.style.color = color;
  score.textContent = det.overall_score.toFixed(1);
  score.appendChild(el("small", undefined, "overall score · 5 = clean"));
  root.appendChild(score);

  const chartWrap = el("div");
  chartWrap.id = "chart-wrap";
  const canvas = document.createElement("canvas");
  canvas.id = "radar-chart";
  chartWrap.appendChild(canvas);
  root.appendChild(chartWrap);

  if (det.summary) {
    root.appendChild(el("p", "summary", det.summary));
  }

  // Map stored responses by smell id.
  const bySmell = new Map(p.responses.map((r) => [r.smellId, r]));

  const sectionEls = new Map<Dimension, HTMLElement>();
  for (const dim of SECTION_DIMENSIONS) {
    const dimResult =
      det.dimensions.find((d) => d.dimension === dim) ??
      ({ dimension: dim, score: 5, smells: [] } as DimensionResult);
    const section = buildDimensionSection(dimResult, bySmell);
    sectionEls.set(dim, section);
    root.appendChild(section);
  }

  // Missed smells + form.
  root.appendChild(buildMissedSmells(p));

  drawChart(
    DIMENSIONS.map(
      (d) => det.dimensions.find((x) => x.dimension === d)?.score ?? 5
    ),
    color,
    (dim) => sectionEls.get(dim)?.scrollIntoView({ behavior: "smooth" })
  );
}

function buildDimensionSection(
  dim: DimensionResult,
  bySmell: Map<string, { decision: string; rationale?: string; shownAt: string }>
): HTMLElement {
  const details = el("details", "dim-section") as HTMLDetailsElement;
  details.open = dim.smells.length > 0;

  const summary = el("summary");
  const nameEl = el(
    "span",
    "dim-name",
    `${DIMENSION_LABELS[dim.dimension]} · ${dim.smells.length}`
  );
  nameEl.title = DIMENSION_DESCRIPTIONS[dim.dimension];
  summary.appendChild(nameEl);
  const badge = el("span", `dim-score ${scoreClass(dim.score)}`, `${dim.score}/5`);
  summary.appendChild(badge);
  details.appendChild(summary);

  if (dim.smells.length === 0) {
    details.appendChild(el("div", "no-smells", "✓ No smells in this dimension."));
    return details;
  }
  dim.smells.forEach((smell, i) => {
    const key = smellResponseKey(dim.dimension, i, smell.id);
    details.appendChild(buildSmell(smell, key, bySmell.get(key)));
  });
  return details;
}

function buildSmell(
  smell: Smell,
  key: string,
  stored?: { decision: string; rationale?: string; shownAt: string }
): HTMLElement {
  if (!shownAt.has(key)) {
    shownAt.set(key, stored?.shownAt ?? new Date().toISOString());
  }

  const card = el("div", `smell sevcard-${smell.severity}`);

  const head = el("div", "smell-head");
  head.appendChild(el("span", `sev sev-${smell.severity}`, smell.severity));
  head.appendChild(el("span", "smell-name", smell.name));
  head.appendChild(
    el("span", "conf", `${Math.round(smell.confidence * 100)}% conf`)
  );
  card.appendChild(head);

  card.appendChild(el("p", "smell-desc", smell.description));

  if (smell.evidence) {
    const ev = el("code", "evidence", smell.evidence);
    ev.title = "Jump to this code";
    ev.addEventListener("click", () =>
      vscode.postMessage({
        type: "jumpTo",
        evidence: smell.evidence,
        char_start: smell.location.char_start,
        char_end: smell.location.char_end,
      })
    );
    card.appendChild(ev);
  }

  // Agree / Disagree / Unsure radios. The response key is unique per card, so
  // it doubles as the radio group name without colliding across cards.
  const radios = el("div", "radios");
  const group = `r-${key}`;
  const rationale = el("textarea", "rationale") as HTMLTextAreaElement;
  rationale.placeholder = "Optional rationale…";
  rationale.rows = 2;
  rationale.style.display = stored ? "block" : "none";
  if (stored?.rationale) rationale.value = stored.rationale;

  const post = (decision: Decision): void => {
    vscode.postMessage({
      type: "response",
      smellId: key,
      decision,
      rationale: rationale.value || undefined,
      shownAt: shownAt.get(key) ?? new Date().toISOString(),
    });
  };

  let current = stored?.decision as Decision | undefined;
  for (const decision of ["agree", "disagree", "unsure"] as const) {
    const label = el("label", `rc rc-${decision}`);
    const input = el("input") as HTMLInputElement;
    input.type = "radio";
    input.name = group;
    input.value = decision;
    if (stored?.decision === decision) input.checked = true;
    input.addEventListener("change", () => {
      current = decision;
      rationale.style.display = "block";
      post(decision);
    });
    label.appendChild(input);
    label.appendChild(el("span", undefined, cap(decision)));
    radios.appendChild(label);
  }
  rationale.addEventListener("change", () => {
    if (current) post(current);
  });

  // Collapsible rationale + remediation ("why & how to fix").
  if (smell.rationale || smell.remediation) {
    const toggle = el("div", "detail-toggle", "▸ why & how to fix");
    const body = el("div", "detail-body");
    body.style.display = "none";
    if (smell.rationale) body.appendChild(el("p", undefined, smell.rationale));
    if (smell.remediation)
      body.appendChild(el("p", undefined, `💡 ${smell.remediation}`));
    toggle.addEventListener("click", () => {
      const open = body.style.display === "block";
      body.style.display = open ? "none" : "block";
      toggle.textContent = open ? "▸ why & how to fix" : "▾ why & how to fix";
    });
    card.appendChild(toggle);
    card.appendChild(body);
  }

  // Reviewer assessment — at the bottom of the card.
  const review = el("div", "review");
  review.appendChild(el("div", "review-label", "Your assessment"));
  review.appendChild(radios);
  review.appendChild(rationale);
  card.appendChild(review);

  return card;
}

function buildMissedSmells(p: RenderFragmentPayload): HTMLElement {
  const wrap = el("div");
  wrap.appendChild(el("h3", "section-title", "Missed smells"));

  for (const m of p.missedSmells) {
    const row = el("div", "smell");
    const head = el("div", "smell-head");
    head.appendChild(el("span", `sev sev-${m.severity}`, m.severity));
    head.appendChild(el("span", "smell-name", `${m.name} (${m.dimension})`));
    row.appendChild(head);
    if (m.rationale) row.appendChild(el("p", "smell-desc", m.rationale));
    wrap.appendChild(row);
  }

  const addBtn = el("button", "action secondary", "+ Add missed smell");
  wrap.appendChild(addBtn);

  const form = el("div", "missed-form");
  const dimSel = el("select") as HTMLSelectElement;
  for (const d of DIMENSIONS) {
    const opt = el("option") as HTMLOptionElement;
    opt.value = d;
    opt.textContent = DIMENSION_LABELS[d];
    dimSel.appendChild(opt);
  }
  const sevSel = el("select") as HTMLSelectElement;
  for (const s of ["minor", "moderate", "major", "critical"] as Severity[]) {
    const opt = el("option") as HTMLOptionElement;
    opt.value = s;
    opt.textContent = s;
    sevSel.appendChild(opt);
  }
  const nameInput = el("input") as HTMLInputElement;
  nameInput.placeholder = "Smell name";
  const rationaleInput = el("textarea") as HTMLTextAreaElement;
  rationaleInput.placeholder = "Why is this a smell? (optional)";
  rationaleInput.rows = 2;
  const submit = el("button", "action", "Add");
  submit.addEventListener("click", () => {
    if (!nameInput.value.trim()) return;
    vscode.postMessage({
      type: "missedSmell",
      dimension: dimSel.value as Dimension,
      name: nameInput.value.trim(),
      severity: sevSel.value as Severity,
      rationale: rationaleInput.value || undefined,
    });
    nameInput.value = "";
    rationaleInput.value = "";
    form.classList.remove("open");
  });
  form.append(dimSel, sevSel, nameInput, rationaleInput, submit);
  addBtn.addEventListener("click", () => form.classList.toggle("open"));
  wrap.appendChild(form);

  return wrap;
}

// ── workspace render ─────────────────────────────────────────────────────────

function renderWorkspace(p: RenderWorkspacePayload): void {
  const root = document.getElementById("root")!;
  root.innerHTML = "";

  const color = workspaceColor(p);
  const score = el("div", "score");
  score.style.color = color;
  score.textContent = p.overall === null ? "–" : p.overall.toFixed(1);
  score.appendChild(el("small", undefined, "workspace score · 5 = clean"));
  root.appendChild(score);

  const chartWrap = el("div");
  chartWrap.id = "chart-wrap";
  const canvas = document.createElement("canvas");
  canvas.id = "radar-chart";
  chartWrap.appendChild(canvas);
  root.appendChild(chartWrap);

  root.appendChild(
    el(
      "p",
      "summary",
      `${p.analyzed} of ${p.detected} detected fragment(s) analyzed` +
        (p.notPrompt > 0 ? ` · ${p.notPrompt} not a prompt` : "") +
        "."
    )
  );

  for (const dim of SECTION_DIMENSIONS) {
    const mean = p.dimensionMeans[dim];
    const section = el("details", "dim-section") as HTMLDetailsElement;
    const summary = el("summary");
    const nameEl = el("span", "dim-name", DIMENSION_LABELS[dim]);
    nameEl.title = DIMENSION_DESCRIPTIONS[dim];
    summary.appendChild(nameEl);
    summary.appendChild(
      el(
        "span",
        `dim-score ${mean === null ? "s-mid" : scoreClass(mean)}`,
        mean === null ? "—" : `${mean}/5`
      )
    );
    section.appendChild(summary);

    const entries = p.byDimension[dim] ?? [];
    section.open = entries.length > 0;
    const body = el("div", "dim-body");
    if (entries.length === 0) {
      body.appendChild(el("div", "no-smells", "✓ No smells in this dimension."));
    } else {
      const totalSmells = entries.reduce((n, e) => n + e.smells.length, 0);
      body.appendChild(
        el(
          "div",
          "dim-agg",
          `${totalSmells} smell${totalSmells === 1 ? "" : "s"} across ${
            entries.length
          } prompt${entries.length === 1 ? "" : "s"}`
        )
      );
      for (const entry of entries) {
        body.appendChild(buildWorkspaceEntry(entry));
      }
    }
    section.appendChild(body);
    root.appendChild(section);
  }

  drawChart(
    DIMENSIONS.map((d) => p.dimensionMeans[d]),
    color
  );
}

function buildWorkspaceEntry(entry: WorkspaceDimEntry): HTMLElement {
  const row = el("div", "ws-frag");
  const head = el("div", "ws-frag-head");
  const link = el("a", "ws-link", `${entry.file}:${entry.line}`);
  link.title = "Open this prompt";
  link.addEventListener("click", () =>
    vscode.postMessage({ type: "revealFragment", fragmentId: entry.fragmentId })
  );
  head.appendChild(link);
  head.appendChild(
    el("span", `dim-score ${scoreClass(entry.score)}`, `${entry.score}/5`)
  );
  row.appendChild(head);
  for (const s of entry.smells) {
    const line = el("div", "ws-smell");
    line.appendChild(el("span", `sev sev-${s.severity}`, s.severity));
    line.appendChild(el("span", "ws-smell-name", s.name));
    row.appendChild(line);
  }
  return row;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── bootstrap ────────────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as { type: string; payload: RenderPayload };
  if (msg.type !== "render") return;
  // Flag light themes so CSS can swap pale-on-tint badge text for darker, legible
  // variants (dark mode keeps its current look).
  document.body.classList.toggle("pr-light", isLightTheme());
  shownAt.clear();
  if (msg.payload.mode === "workspace") {
    renderWorkspace(msg.payload);
  } else {
    renderFragment(msg.payload);
  }
});

vscode.postMessage({ type: "ready" });
