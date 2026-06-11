import {
  type CompleteOptions,
  type LLMProvider,
  ProviderError,
} from "./LLMProvider";
import { errorMessage } from "../util/errors";

export interface AzureConfig {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string;
}

// Azure OpenAI BYOK provider (spec §7.1). Uses the global fetch (Node 18+); no
// SDK dependency. The API key is passed in from SecretStorage and is never
// logged.
export class AzureOpenAIProvider implements LLMProvider {
  readonly name = "azureOpenAI";

  constructor(private readonly config: AzureConfig) {}

  async complete(prompt: string, options: CompleteOptions): Promise<string> {
    const { endpoint, deployment, apiVersion, apiKey } = this.config;
    const url =
      `${endpoint.replace(/\/+$/, "")}/openai/deployments/` +
      `${encodeURIComponent(deployment)}/chat/completions` +
      `?api-version=${encodeURIComponent(apiVersion)}`;

    // Abort on either the caller's signal or our own timeout.
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          temperature: options.temperature,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (options.signal.aborted) {
        throw new ProviderError("timeout", "Request cancelled.", err);
      }
      if (controller.signal.aborted) {
        throw new ProviderError(
          "timeout",
          `Azure OpenAI request timed out after ${options.timeoutMs} ms.`,
          err
        );
      }
      throw new ProviderError(
        "network",
        `Network error contacting Azure OpenAI: ${errorMessage(err)}`,
        err
      );
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
      const detail = await safeBodyText(response);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(
          "auth",
          `Azure OpenAI authentication failed (HTTP ${response.status}). Check the API key and endpoint.`
        );
      }
      if (response.status === 429) {
        throw new ProviderError(
          "rate_limit",
          "Azure OpenAI rate limit reached (HTTP 429). Retry shortly."
        );
      }
      throw new ProviderError(
        "unknown",
        `Azure OpenAI returned HTTP ${response.status}: ${truncate(detail, 300)}`
      );
    }

    let body: { choices?: Array<{ message?: { content?: string } }> };
    try {
      body = (await response.json()) as typeof body;
    } catch (err) {
      throw new ProviderError(
        "invalid_response",
        "Azure OpenAI returned a non-JSON body.",
        err
      );
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new ProviderError(
        "invalid_response",
        "Azure OpenAI response contained no message content."
      );
    }
    return content;
  }
}

async function safeBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
