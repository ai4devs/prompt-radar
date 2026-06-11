// Provider abstraction (spec §7). A provider turns a fully-rendered prompt
// string into a raw completion string. All provider failures are normalized to
// a single typed ProviderError so the UI can react uniformly (banner + action).

export interface CompleteOptions {
  temperature: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface LLMProvider {
  /** Stable identifier for logging: "azureOpenAI". */
  readonly name: string;
  complete(prompt: string, options: CompleteOptions): Promise<string>;
}

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** The recommended side-panel banner action for each error kind (spec §7.3). */
export function bannerActionForKind(
  kind: ProviderErrorKind
): "openSettings" | "retry" | undefined {
  switch (kind) {
    case "auth":
      return "openSettings";
    case "rate_limit":
    case "timeout":
    case "network":
      return "retry";
    default:
      return undefined;
  }
}
