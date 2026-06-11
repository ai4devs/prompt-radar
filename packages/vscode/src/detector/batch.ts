import * as vscode from "vscode";
import { Detector, DetectorError } from "./Detector";
import { ProviderError } from "../llm/LLMProvider";
import type { PromptIndexStore } from "../model/PromptIndexStore";
import type { Fragment } from "../model/types";
import type { Logger } from "../util/logger";
import { errorMessage } from "../util/errors";

export interface BatchOutcome {
  analyzed: number;
  failed: number;
  cancelled: boolean;
  providerError?: ProviderError;
}

// Batch analysis with a concurrency-limited worker pool (spec §6.2). Default
// maxConcurrent = 2. Cancellable. Aborts the whole batch on the first
// ProviderError (it would recur for every fragment) and surfaces it.
export async function analyzeFragments(params: {
  fragments: Fragment[];
  detector: Detector;
  index: PromptIndexStore;
  maxConcurrent: number;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  token: vscode.CancellationToken;
  logger: Logger;
}): Promise<BatchOutcome> {
  const { fragments, detector, index, progress, token, logger } = params;
  const total = fragments.length;

  const controller = new AbortController();
  const cancelSub = token.onCancellationRequested(() => controller.abort());

  let next = 0;
  let done = 0;
  let analyzed = 0;
  let failed = 0;
  let providerError: ProviderError | undefined;

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const idx = next++;
      if (idx >= total) {
        return;
      }
      const fragment = fragments[idx];
      try {
        const result = await detector.analyze(
          fragment.artifactText,
          controller.signal
        );
        index.upsert({
          ...fragment,
          artifactType: result.artifact_type,
          toolOutput: result,
          analyzedAt: new Date().toISOString(),
          failed: false,
        });
        analyzed++;
      } catch (err) {
        if (err instanceof ProviderError) {
          providerError = err;
          controller.abort();
          return;
        }
        if (err instanceof DetectorError) {
          index.upsert({
            ...fragment,
            failed: true,
            analyzedAt: new Date().toISOString(),
          });
        } else {
          logger.error(`batch ${fragment.file}: ${errorMessage(err)}`);
        }
        failed++;
      } finally {
        done++;
        progress.report({
          message: `${done}/${total}`,
          increment: total ? 100 / total : 0,
        });
      }
    }
  };

  const poolSize = Math.max(1, Math.min(maxConcurrentSafe(params.maxConcurrent), total));
  try {
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  } finally {
    cancelSub.dispose();
  }

  return {
    analyzed,
    failed,
    cancelled: token.isCancellationRequested,
    providerError,
  };
}

function maxConcurrentSafe(n: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}
