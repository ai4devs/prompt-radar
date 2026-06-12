import * as vscode from "vscode";
import { CATALOG_VERSION, DETECTOR_PROMPT_VERSION } from "../detector/types";
import type { Smell } from "../detector/schema";
import { smellResponseKey } from "../model/types";
import { Debouncer } from "../util/debounce";
import { sha256 } from "../util/hash";
import { errorMessage } from "../util/errors";
import type { PromptIndexStore } from "../model/PromptIndexStore";
import type { ResponseLogStore } from "../model/ResponseLogStore";
import type { Logger } from "../util/logger";

// Collection endpoint baked into the published build. Rows are appended to a
// Supabase table through the PostgREST API using the anon (publishable) key
// under an INSERT-only Row Level Security policy, so the key shipped with the
// extension can only add rows — never read, change, or delete them. If the key
// is ever abused, rotate it in the Supabase dashboard and ship a patch release.
const COLLECTOR_URL = "https://gsnvjxhpziicebsfdnax.supabase.co";
const COLLECTOR_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzbnZqeGhwemlpY2Vic2ZkbmF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyMjQ0NTgsImV4cCI6MjA5NjgwMDQ1OH0.bYBFu3nZVnO4GtdPr9dT4u9ppGeZhlR4HI8VvV00zYg";
const COLLECTOR_TABLE = "pr_feedback";

export function collectorConfigured(): boolean {
  return COLLECTOR_URL.length > 0 && COLLECTOR_ANON_KEY.length > 0;
}

// Opt-in feedback telemetry. There is no "session" concept: the unit of
// collection is one feedback event — the user agreeing/disagreeing/unsure-ing
// with a detected smell, or reporting a smell the detector missed. Each event
// is self-contained: the prompt-as-code, the smell being judged, a compact
// list of everything the detector found, the model that produced the
// analysis, and version metadata, tagged with VS Code's anonymous machine id.
//
// Behavior:
//   - sends only when promptRadar.telemetry.enabled is on AND VS Code's own
//     telemetry is not disabled (vscode.env.isTelemetryEnabled)
//   - debounced 30 s after a feedback change, flushed on deactivate
//   - already-sent events are skipped via a content hash persisted in
//     workspaceState (a revised decision re-sends with the new content; the
//     collector keeps the latest row per machine_id + artifact + smell)
//   - failures only log to the output channel and are retried on the next
//     change/flush; the UI is never blocked
const UPLOAD_DEBOUNCE_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 15_000;
const SENT_EVENTS_KEY = "promptRadar.telemetry.sentEvents";

interface FeedbackRow {
  machine_id: string;
  event_type: "smell_feedback" | "missed_smell";
  artifact_sha256: string;
  smell_id: string | null;
  payload: unknown;
}

interface FeedbackEvent {
  /** Stable identity for dedup (not uploaded). */
  key: string;
  row: FeedbackRow;
}

export class FeedbackUploader implements vscode.Disposable {
  private readonly debouncer = new Debouncer(
    () => this.upload(),
    UPLOAD_DEBOUNCE_MS
  );
  private readonly disposables: vscode.Disposable[] = [];
  private announced = false;

  constructor(
    private readonly index: PromptIndexStore,
    private readonly responses: ResponseLogStore,
    private readonly extensionVersion: string,
    private readonly workspaceState: vscode.Memento,
    private readonly logger: Logger
  ) {
    this.disposables.push(
      this.responses.onDidChange(() => this.debouncer.schedule()),
      // Index changes matter too: a re-analysis can attach the model name to a
      // fragment after feedback on it was already recorded.
      this.index.onDidChange(() => this.debouncer.schedule())
    );
  }

  /** Upload any pending feedback immediately (called on deactivate). */
  async flush(): Promise<void> {
    await this.debouncer.flush();
  }

  private buildEvents(): FeedbackEvent[] {
    const events: FeedbackEvent[] = [];
    const meta = {
      machine_id: vscode.env.machineId,
      extension_version: this.extensionVersion,
      catalog_version: CATALOG_VERSION,
      detector_prompt_version: DETECTOR_PROMPT_VERSION,
    };

    for (const f of this.index.all()) {
      const responses = this.responses.responsesFor(f.id);
      const missed = this.responses.missedSmellsFor(f.id);
      if (responses.length === 0 && missed.length === 0) {
        continue;
      }

      const prompt = {
        text: f.artifactText,
        sha256: f.artifactTextSha256,
        artifact_type: f.artifactType,
        file: f.file,
      };
      const analysis = f.toolOutput
        ? {
            overall_score: f.toolOutput.overall_score,
            summary: f.toolOutput.summary,
            dimension_scores: Object.fromEntries(
              f.toolOutput.dimensions.map((d) => [d.dimension, d.score])
            ),
            detected_smells: f.toolOutput.dimensions.flatMap((d) =>
              d.smells.map((s) => ({
                dimension: d.dimension,
                id: s.id,
                name: s.name,
                severity: s.severity,
              }))
            ),
          }
        : null;

      // Resolve each per-occurrence response key back to the smell it judged.
      const byKey = new Map<string, { dimension: string; smell: Smell }>();
      for (const d of f.toolOutput?.dimensions ?? []) {
        d.smells.forEach((smell, i) =>
          byKey.set(smellResponseKey(d.dimension, i, smell.id), {
            dimension: d.dimension,
            smell,
          })
        );
      }

      for (const r of responses) {
        const judged = byKey.get(r.smellId);
        events.push({
          key: `response|${f.id}|${r.smellId}`,
          row: {
            machine_id: meta.machine_id,
            event_type: "smell_feedback",
            artifact_sha256: f.artifactTextSha256,
            smell_id: r.smellId,
            payload: {
              ...meta,
              model: f.model ?? null,
              prompt,
              analysis,
              smell: judged
                ? { dimension: judged.dimension, ...judged.smell }
                : null,
              feedback: {
                decision: r.decision,
                rationale: r.rationale ?? null,
                shown_at: r.shownAt,
                responded_at: r.respondedAt,
                changed_count: r.changedCount,
              },
            },
          },
        });
      }

      for (const m of missed) {
        events.push({
          key: `missed|${f.id}|${m.addedAt}|${m.dimension}|${m.name}`,
          row: {
            machine_id: meta.machine_id,
            event_type: "missed_smell",
            artifact_sha256: f.artifactTextSha256,
            smell_id: null,
            payload: {
              ...meta,
              model: f.model ?? null,
              prompt,
              analysis,
              missed_smell: {
                dimension: m.dimension,
                name: m.name,
                severity: m.severity,
                span: m.span,
                rationale: m.rationale ?? null,
                added_at: m.addedAt,
              },
            },
          },
        });
      }
    }
    return events;
  }

  private async upload(): Promise<void> {
    if (!collectorConfigured()) {
      return;
    }
    const enabled = vscode.workspace
      .getConfiguration("promptRadar")
      .get<boolean>("telemetry.enabled", false);
    if (!enabled || !vscode.env.isTelemetryEnabled) {
      return;
    }

    const sent = {
      ...this.workspaceState.get<Record<string, string>>(SENT_EVENTS_KEY, {}),
    };
    const pending = this.buildEvents()
      .map((event) => ({ event, hash: sha256(JSON.stringify(event.row)) }))
      .filter(({ event, hash }) => sent[event.key] !== hash);
    if (pending.length === 0) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${COLLECTOR_URL}/rest/v1/${encodeURIComponent(COLLECTOR_TABLE)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: COLLECTOR_ANON_KEY,
            Authorization: `Bearer ${COLLECTOR_ANON_KEY}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify(pending.map(({ event }) => event.row)),
          signal: controller.signal,
        }
      );
      if (!response.ok) {
        this.logger.verbose(
          `telemetry: HTTP ${response.status} from collector — ${truncate(
            await safeText(response),
            300
          )} (will retry on the next change).`
        );
        return;
      }
      for (const { event, hash } of pending) {
        sent[event.key] = hash;
      }
      await this.workspaceState.update(SENT_EVENTS_KEY, sent);
      if (this.announced) {
        this.logger.verbose(
          `telemetry: ${pending.length} feedback event(s) sent.`
        );
      } else {
        this.announced = true;
        // The machine id is logged so users can quote it in deletion requests
        // (see PRIVACY.md "Retention and deletion").
        this.logger.info(
          `telemetry: ${pending.length} anonymized feedback event(s) sent · machine id ${vscode.env.machineId} (promptRadar.telemetry.enabled is on).`
        );
      }
    } catch (err) {
      this.logger.verbose(
        `telemetry: upload failed — ${errorMessage(err)} (will retry on the next change).`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    this.debouncer.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** One-time, non-modal opt-in prompt. Asked once per installation per consent
 *  version — bump the version if a future release materially widens what is
 *  collected (promised in PRIVACY.md). Changeable anytime via
 *  promptRadar.telemetry.enabled. */
export async function maybePromptTelemetryOptIn(
  context: vscode.ExtensionContext
): Promise<void> {
  const PROMPT_SHOWN_KEY = "promptRadar.telemetryPromptShown.v1";
  if (!collectorConfigured() || !vscode.env.isTelemetryEnabled) {
    return;
  }
  if (context.globalState.get<boolean>(PROMPT_SHOWN_KEY)) {
    return;
  }
  await context.globalState.update(PROMPT_SHOWN_KEY, true);
  const pick = await vscode.window.showInformationMessage(
    "Help improve Prompt Radar by sharing anonymized feedback? " +
      "When you agree/disagree with a detected smell (or add a missed one), the " +
      "analyzed prompt text, the detected smells, your assessment, and the model " +
      "used are shared — never API keys or other workspace content. " +
      "You can change this anytime via the promptRadar.telemetry.enabled setting.",
    "Share",
    "No Thanks"
  );
  if (pick === "Share") {
    await vscode.workspace
      .getConfiguration("promptRadar")
      .update("telemetry.enabled", true, vscode.ConfigurationTarget.Global);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
