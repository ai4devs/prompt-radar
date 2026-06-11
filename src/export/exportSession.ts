import * as vscode from "vscode";
import { CATALOG_VERSION, DETECTOR_PROMPT_VERSION } from "../detector/types";
import type { PromptIndexStore } from "../model/PromptIndexStore";
import type { ResponseLogStore } from "../model/ResponseLogStore";

const SETTINGS_QUERY = "@ext:vanilson.prompt-radar";

// Build + write the self-contained session-log JSON (spec §8.2) with the consent
// gate (spec §8.3): when consent is off, the pseudonym is null/omitted.
export async function exportSessionLog(
  index: PromptIndexStore,
  responses: ResponseLogStore,
  extensionVersion: string
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("promptRadar");
  const consent = cfg.get<boolean>("research.consent", false);
  const pseudonym = cfg.get<string>("session.pseudonym", "").trim();

  if (consent && pseudonym.length === 0) {
    const pick = await vscode.window.showWarningMessage(
      "Prompt Radar: research consent is on but no pseudonym is set. Set promptRadar.session.pseudonym before exporting.",
      "Open Settings"
    );
    if (pick === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        SETTINGS_QUERY
      );
    }
    return;
  }

  const doc = buildExport(index, responses, extensionVersion, consent, pseudonym);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `prompt-radar-session-${stamp}.json`;
  const defaultUri = defaultLocation(defaultName);

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { JSON: ["json"] },
    saveLabel: "Export Session Log",
  });
  if (!target) {
    return;
  }

  const text = JSON.stringify(doc, null, 2);
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));

  const open = await vscode.window.showInformationMessage(
    `Prompt Radar: session log exported (${doc.fragments.length} fragment(s)).`,
    "Open"
  );
  if (open === "Open") {
    await vscode.window.showTextDocument(target);
  }
}

interface ExportDoc {
  session_id: string;
  pseudonym: string | null;
  research_consent: boolean;
  catalog_version: string;
  detector_prompt_version: string;
  extension_version: string;
  started_at: string;
  completed_at: string;
  fragments: unknown[];
}

function buildExport(
  index: PromptIndexStore,
  responses: ResponseLogStore,
  extensionVersion: string,
  consent: boolean,
  pseudonym: string
): ExportDoc {
  const fragments = index
    .all()
    .filter((f) => f.toolOutput)
    .map((f) => ({
      fragment_id: f.id,
      file: f.file,
      span: f.span,
      artifact_text_sha256: f.artifactTextSha256,
      artifact_text: f.artifactText,
      tool_output: f.toolOutput,
      responses: responses.responsesFor(f.id),
      missed_smells: responses.missedSmellsFor(f.id),
    }));

  return {
    session_id: responses.sessionId,
    pseudonym: consent ? pseudonym : null,
    research_consent: consent,
    catalog_version: CATALOG_VERSION,
    detector_prompt_version: DETECTOR_PROMPT_VERSION,
    extension_version: extensionVersion,
    started_at: responses.startedAt,
    completed_at: new Date().toISOString(),
    fragments,
  };
}

function defaultLocation(name: string): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, name) : undefined;
}
