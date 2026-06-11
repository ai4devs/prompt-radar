import * as vscode from "vscode";
import { AzureOpenAIProvider } from "./AzureOpenAIProvider";
import { VsCodeLmProvider } from "./VsCodeLmProvider";
import { getApiKey } from "./apiKey";
import { type LLMProvider, ProviderError } from "./LLMProvider";
import type { Logger } from "../util/logger";

// Provider selection (spec §2/§7): use Azure OpenAI BYOK only when it is fully
// configured (provider setting + endpoint + deployment + apiVersion + key in
// SecretStorage); otherwise fall back to vscode.lm.
export async function createProvider(
  secrets: vscode.SecretStorage,
  logger: Logger
): Promise<LLMProvider> {
  const cfg = vscode.workspace.getConfiguration("promptRadar");
  const provider = cfg.get<string>("provider", "vscodeLM");
  const endpoint = cfg.get<string>("azure.endpoint", "").trim();
  const deployment = cfg.get<string>("azure.deployment", "").trim();
  const apiVersion = cfg.get<string>("azure.apiVersion", "").trim();
  const apiKey = (await getApiKey(secrets))?.trim();

  if (provider === "azureOpenAI") {
    if (endpoint && deployment && apiVersion && apiKey) {
      logger.info(
        `provider: Azure OpenAI (deployment=${deployment}, apiVersion=${apiVersion}).`
      );
      return new AzureOpenAIProvider({ endpoint, deployment, apiVersion, apiKey });
    }
    if (endpoint && deployment && apiVersion && !apiKey) {
      // Configured except the key — surface an actionable error rather than
      // silently using Copilot.
      throw new ProviderError(
        "auth",
        "Azure OpenAI API key not set. Run “Prompt Radar: Configure API Key”."
      );
    }
    logger.info(
      "provider: azureOpenAI selected but endpoint/deployment/apiVersion are incomplete — falling back to vscodeLM."
    );
  } else {
    logger.info("provider: VS Code Language Model (vscodeLM).");
  }

  const family = cfg.get<string>("model", "").trim();
  return new VsCodeLmProvider(logger, family);
}

export function readLlmOptions(): { temperature: number; timeoutMs: number } {
  const cfg = vscode.workspace.getConfiguration("promptRadar");
  return {
    temperature: cfg.get<number>("temperature", 0),
    timeoutMs: cfg.get<number>("timeoutMs", 60000),
  };
}
