import * as vscode from "vscode";
import type { LLMProvider } from "../llm/LLMProvider";
import type { Logger } from "../util/logger";
import { buildDetectorPrompt } from "./promptBuilder";
import { parseJsonObject } from "./jsonParse";
import { DetectorJSONSchema, type DetectorJSON } from "./schema";
import { recomputeScores } from "./scoring";

/** Raised when the model cannot be coerced into valid detector JSON. */
export class DetectorError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "DetectorError";
    this.raw = raw;
  }
}

const RETRY_SUFFIX = "\n\nReturn only valid JSON, no commentary.";

// Renders the bundled prompt for one artifact, sends it via the active provider,
// parses + validates the JSON (retrying once), and recomputes the scores
// deterministically (spec §6.2). Logs each request/response so activity is
// observable. ProviderError propagates for the banner; DetectorError signals a
// malformed result.
export class Detector {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly provider: LLMProvider,
    private readonly logger: Logger,
    private readonly options: { temperature: number; timeoutMs: number }
  ) {}

  /** Model that served the last completion (best effort; see LLMProvider.model). */
  get model(): string | undefined {
    return this.provider.model;
  }

  async analyze(artifact: string, signal: AbortSignal): Promise<DetectorJSON> {
    const basePrompt = await buildDetectorPrompt(this.extensionUri, artifact);
    let lastRaw = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = attempt === 1 ? basePrompt : basePrompt + RETRY_SUFFIX;
      this.logger.info(
        `→ LLM request (attempt ${attempt}/2) · provider=${this.provider.name} · promptChars=${prompt.length} · artifactChars=${artifact.length}`
      );
      const startedMs = Date.now();
      const raw = await this.provider.complete(prompt, {
        temperature: this.options.temperature,
        timeoutMs: this.options.timeoutMs,
        signal,
      });
      lastRaw = raw;
      this.logger.info(
        `← LLM response · chars=${raw.length} · ${Date.now() - startedMs}ms`
      );

      const validated = DetectorJSONSchema.safeParse(parseJsonObject(raw));
      if (validated.success) {
        const result = recomputeScores(validated.data);
        this.logger.info(
          `detector ok · overall=${result.overall_score} · ${result.dimensions
            .map((d) => `${d.dimension[0].toUpperCase()}${d.score}`)
            .join(" ")} · smells=${result.dimensions.reduce(
            (n, d) => n + d.smells.length,
            0
          )}`
        );
        return result;
      }

      this.logger.info(
        `detector: attempt ${attempt} produced invalid output${
          attempt === 1 ? " — retrying with JSON-only instruction" : ""
        }.`
      );
      if (attempt === 2) {
        this.logger.error("detector: malformed output after retry.");
        this.logger.appendLine("=== Raw response ===");
        this.logger.appendLine(raw || "(empty)");
        this.logger.appendLine("=== Zod issues ===");
        this.logger.appendLine(JSON.stringify(validated.error.issues, null, 2));
      }
    }

    throw new DetectorError("Model returned malformed output.", lastRaw);
  }
}
