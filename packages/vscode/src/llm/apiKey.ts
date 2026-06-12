import * as vscode from "vscode";

// The API key lives exclusively in vscode.SecretStorage (spec §2). It is never
// written to settings.json, never logged, never bundled.
export const API_KEY_SECRET = "promptRadar.azure.apiKey";

export function getApiKey(
  secrets: vscode.SecretStorage
): Thenable<string | undefined> {
  return secrets.get(API_KEY_SECRET);
}

/** Command handler for `promptRadar.configureApiKey`: prompt for and store the key. */
export async function configureApiKey(
  secrets: vscode.SecretStorage
): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "Prompt Radar: API Key",
    prompt:
      "Enter your API key for the selected BYOK provider (OpenAI-compatible or Azure OpenAI). It is stored securely in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
  });

  if (key === undefined) {
    return; // cancelled
  }
  if (key.trim().length === 0) {
    await secrets.delete(API_KEY_SECRET);
    await vscode.window.showInformationMessage("Prompt Radar: API key cleared.");
    return;
  }
  await secrets.store(API_KEY_SECRET, key.trim());
  await vscode.window.showInformationMessage("Prompt Radar: API key saved.");
}
