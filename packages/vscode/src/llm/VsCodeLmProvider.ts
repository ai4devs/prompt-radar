import * as vscode from "vscode";
import {
  type CompleteOptions,
  type LLMProvider,
  ProviderError,
} from "./LLMProvider";
import type { Logger } from "../util/logger";
import { errorMessage } from "../util/errors";

// VS Code Language Model fallback provider (spec §7.2). Wraps vscode.lm behind
// the LLMProvider interface. If a preferred family is configured but matches no
// model, it falls back to any available model rather than failing — the
// configured family string often doesn't match the host's catalog.
export class VsCodeLmProvider implements LLMProvider {
  readonly name = "vscodeLM";

  constructor(
    private readonly logger: Logger,
    private readonly preferredFamily: string
  ) {}

  async complete(prompt: string, options: CompleteOptions): Promise<string> {
    const model = await this.pickModel();

    const cts = new vscode.CancellationTokenSource();
    const onAbort = (): void => cts.cancel();
    const timer = setTimeout(() => cts.cancel(), options.timeoutMs);
    if (options.signal.aborted) {
      cts.cancel();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    let raw = "";
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {
          justification: "Analyzing a prompt fragment for prompt smells.",
          modelOptions: { temperature: options.temperature },
        },
        cts.token
      );
      for await (const chunk of response.text) {
        raw += chunk;
      }
    } catch (err) {
      throw this.mapError(err, options.signal.aborted);
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      cts.dispose();
    }

    return raw;
  }

  private async pickModel(): Promise<vscode.LanguageModelChat> {
    let models: readonly vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels(
        this.preferredFamily ? { family: this.preferredFamily } : {}
      );
    } catch (err) {
      throw new ProviderError(
        "unknown",
        `Failed to query language models: ${errorMessage(err)}`,
        err
      );
    }

    if (models.length === 0 && this.preferredFamily) {
      this.logger.info(
        `vscodeLM: no model matches family "${this.preferredFamily}" — falling back to any available model.`
      );
      try {
        models = await vscode.lm.selectChatModels({});
      } catch (err) {
        throw new ProviderError("unknown", errorMessage(err), err);
      }
    }

    if (models.length === 0) {
      throw new ProviderError(
        "auth",
        "No language models available. Sign in to GitHub Copilot or configure an Azure OpenAI provider."
      );
    }

    this.logger.verbose(
      `vscodeLM available: ${models
        .map((m) => `${m.family}/${m.id}`)
        .join(", ")}`
    );
    const model = models[0];
    this.logger.info(
      `vscodeLM model: ${model.name} (vendor=${model.vendor}, family=${model.family}, id=${model.id})`
    );
    return model;
  }

  private mapError(err: unknown, externallyCancelled: boolean): ProviderError {
    if (err instanceof vscode.LanguageModelError) {
      if (err.code === "NoPermissions" || err.code === "Blocked") {
        return new ProviderError("auth", err.message, err);
      }
      return new ProviderError("unknown", err.message, err);
    }
    if (
      externallyCancelled ||
      err instanceof vscode.CancellationError ||
      errorMessage(err).toLowerCase().includes("cancel")
    ) {
      return new ProviderError("timeout", "Request cancelled or timed out.", err);
    }
    return new ProviderError("unknown", errorMessage(err), err);
  }
}
