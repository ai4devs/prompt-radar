import {
  type CompleteOptions,
  type LLMProvider,
  ProviderError,
} from "./LLMProvider";
import { errorMessage } from "../util/errors";

export interface OpenAICompatibleConfig {
  /** Base URL of the OpenAI-compatible API, e.g. https://api.openai.com/v1.
   *  Trailing slashes are stripped before "/chat/completions" is appended. */
  baseUrl: string;
  /** Model id sent in the request body, e.g. gpt-4o, deepseek-chat. */
  model: string;
  apiKey: string;
}

// Generic OpenAI-compatible BYOK provider (spec §7.1). Works with any endpoint
// that implements POST {baseUrl}/chat/completions with bearer auth: OpenAI,
// DeepSeek, Gemini (AI Studio), Anthropic, Mistral, Groq, OpenRouter, xAI, and
// local Ollama/LM Studio. Uses the global fetch (Node 18+); no SDK dependency.
// The API key is passed in from SecretStorage and is never logged.
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openaiCompatible";

  constructor(private readonly config: OpenAICompatibleConfig) {}

  get model(): string {
    return this.config.model;
  }

  async complete(prompt: string, options: CompleteOptions): Promise<string> {
    const { baseUrl, model, apiKey } = this.config;
    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

    // Abort on either the caller's signal or our own timeout.
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    // The timer stays armed until the BODY has been read too — reading the
    // response stream shares the abort signal, so a stalled body also times out.
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: options.temperature,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        throw this.abortOr(
          err,
          options,
          new ProviderError(
            "network",
            `Network error contacting the OpenAI-compatible endpoint: ${errorMessage(err)}`,
            err
          )
        );
      }

      if (!response.ok) {
        const detail = await safeBodyText(response);
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError(
            "auth",
            `OpenAI-compatible endpoint authentication failed (HTTP ${response.status}). Check the API key and base URL.`
          );
        }
        if (response.status === 429) {
          throw new ProviderError(
            "rate_limit",
            "OpenAI-compatible endpoint rate limit reached (HTTP 429). Retry shortly."
          );
        }
        throw new ProviderError(
          "unknown",
          `OpenAI-compatible endpoint returned HTTP ${response.status}: ${truncate(detail, 300)}`
        );
      }

      let body: { choices?: Array<{ message?: { content?: string } }> };
      try {
        body = (await response.json()) as typeof body;
      } catch (err) {
        throw this.abortOr(
          err,
          options,
          new ProviderError(
            "invalid_response",
            "OpenAI-compatible endpoint returned a non-JSON body.",
            err
          )
        );
      }

      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new ProviderError(
          "invalid_response",
          "OpenAI-compatible endpoint response contained no message content."
        );
      }
      return content;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /** Map an error to cancel/timeout when an abort caused it; otherwise use `fallback`. */
  private abortOr(
    err: unknown,
    options: CompleteOptions,
    fallback: ProviderError
  ): ProviderError {
    if (options.signal.aborted) {
      return new ProviderError("timeout", "Request cancelled.", err);
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      return new ProviderError(
        "timeout",
        `OpenAI-compatible request timed out after ${options.timeoutMs} ms.`,
        err
      );
    }
    return fallback;
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
