import * as vscode from "vscode";
import { Detector, DetectorError } from "./detector/Detector";
import { analyzeFragments } from "./detector/batch";
import type { DetectorJSON } from "./detector/schema";
import {
  FeedbackUploader,
  maybePromptTelemetryOptIn,
} from "./telemetry/FeedbackUploader";
import { ProviderError, bannerActionForKind } from "./llm/LLMProvider";
import { createProvider, readLlmOptions } from "./llm/providerFactory";
import { configureApiKey } from "./llm/apiKey";
import { PromptIndexStore } from "./model/PromptIndexStore";
import { ResponseLogStore } from "./model/ResponseLogStore";
import type { Fragment } from "./model/types";
import { Scanner } from "./scanner/Scanner";
import { InlineController } from "./presentation/inlineController";
import {
  PromptsTreeDataProvider,
  type TreeNode,
} from "./views/PromptsTreeDataProvider";
import { RadarPanel } from "./views/RadarPanel";
import { SummaryViewProvider } from "./views/SummaryViewProvider";
import { Logger } from "./util/logger";
import { fragmentId, sha256 } from "./util/hash";
import { errorMessage } from "./util/errors";

const SETTINGS_QUERY = "@ext:vanilson.prompt-radar";

let promptIndex: PromptIndexStore | undefined;
let responseLog: ResponseLogStore | undefined;
let summaryProvider: SummaryViewProvider | undefined;
let feedbackUploader: FeedbackUploader | undefined;

// Fragment ids with an analysis currently in flight — guards against double
// clicks / concurrent triggers starting duplicate LLM calls for one fragment.
const fragmentsInFlight = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Prompt Radar");
  const logger = new Logger(outputChannel);

  const index = new PromptIndexStore();
  const responses = new ResponseLogStore();
  promptIndex = index;
  responseLog = responses;
  await Promise.all([index.load(), responses.load()]);

  const inline = new InlineController(index);
  inline.refreshAll();

  const summary = new SummaryViewProvider(context.extensionUri, index, responses);
  summaryProvider = summary;
  const tree = new PromptsTreeDataProvider(index, responses);
  const radar = new RadarPanel(context.extensionUri, index, responses, logger);
  const uploader = new FeedbackUploader(
    index,
    responses,
    context.extension.packageJSON.version ?? "0.1.0",
    context.workspaceState,
    logger
  );
  feedbackUploader = uploader;

  context.subscriptions.push(
    outputChannel,
    index,
    responses,
    inline,
    uploader,
    summary,
    tree,
    radar,
    vscode.window.registerWebviewViewProvider(
      SummaryViewProvider.viewType,
      summary
    ),
    vscode.window.registerTreeDataProvider("promptRadar.prompts", tree),

    vscode.commands.registerCommand("promptRadar.analyzeSelection", () =>
      analyzeSelection(context, logger, index, radar)
    ),

    vscode.commands.registerCommand("promptRadar.configureApiKey", () =>
      configureApiKey(context.secrets)
    ),

    vscode.commands.registerCommand("promptRadar.clearAnalysis", async () => {
      const analyzed = index
        .all()
        .filter((f) => f.toolOutput || f.failed).length;
      if (analyzed === 0) {
        await vscode.window.showInformationMessage(
          "Prompt Radar: no analysis results to clear."
        );
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `Clear analysis results for ${analyzed} fragment(s)? The detected prompts stay in the list and can be re-analyzed.`,
        { modal: true },
        "Clear Analysis"
      );
      if (pick === "Clear Analysis") {
        index.clearAnalysis();
        vscode.window.showInformationMessage("Prompt Radar: analysis results cleared.");
      }
    }),

    vscode.commands.registerCommand("promptRadar.clearWorkspace", async () => {
      const count = index.all().length;
      if (count === 0) {
        await vscode.window.showInformationMessage(
          "Prompt Radar: no workspace results to clear."
        );
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `Remove all ${count} detected prompt(s) from the list? The analysis is kept and re-attached on the next Scan Workspace (for prompts whose text is unchanged). Your review responses are kept too — use Clear Session Log for those.`,
        { modal: true },
        "Remove Detected Prompts"
      );
      if (pick === "Remove Detected Prompts") {
        index.clearKeepAnalysis();
        vscode.window.showInformationMessage(
          "Prompt Radar: detected prompts removed. Run Scan Workspace to re-detect them with analysis pre-loaded."
        );
      }
    }),

    vscode.commands.registerCommand("promptRadar.clearSessionLog", async () => {
      const pick = await vscode.window.showWarningMessage(
        "Clear the Prompt Radar session log (all responses and missed smells)?",
        { modal: true },
        "Clear"
      );
      if (pick === "Clear") {
        responses.clear();
        vscode.window.showInformationMessage("Prompt Radar: session log cleared.");
      }
    }),

    vscode.commands.registerCommand("promptRadar.scanWorkspace", () =>
      scanWorkspace(logger, index)
    ),

    vscode.commands.registerCommand("promptRadar.rescanCurrentFile", () =>
      rescanCurrentFile(logger, index)
    ),

    vscode.commands.registerCommand("promptRadar.openFragment", (id: string) =>
      openFragment(context, logger, index, radar, id)
    ),

    vscode.commands.registerCommand(
      "promptRadar.removeFragment",
      (node?: TreeNode) => {
        if (node?.kind === "fragment") {
          index.remove(node.fragment.id);
        } else if (node?.kind === "file") {
          index.replaceFile(node.file, []);
        }
      }
    ),

    vscode.commands.registerCommand("promptRadar.addFragmentFromSelection", () =>
      addFragmentFromSelection(index)
    ),

    vscode.commands.registerCommand("promptRadar.openWorkspaceDashboard", () =>
      radar.showWorkspace()
    ),

    vscode.commands.registerCommand("promptRadar.analyzeAllDetected", () =>
      analyzeAllDetected(context, logger, index)
    )
  );

  void maybePromptTelemetryOptIn(context);

  logger.info(
    `Prompt Radar activated · session=${responses.sessionId} · ${index.all().length} fragment(s) in index.`
  );
}

export async function deactivate(): Promise<void> {
  await Promise.all([
    promptIndex?.flush(),
    responseLog?.flush(),
    feedbackUploader?.flush(),
  ]);
}

async function analyzeAllDetected(
  context: vscode.ExtensionContext,
  logger: Logger,
  index: PromptIndexStore
): Promise<void> {
  const pending = index
    .all()
    .filter((f) => !f.toolOutput && !fragmentsInFlight.has(f.id));
  if (pending.length === 0) {
    await vscode.window.showInformationMessage(
      "Prompt Radar: no unanalyzed prompts. Run Scan Workspace first."
    );
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Analyze all ${pending.length} detected prompt(s)? This makes ${pending.length} LLM call(s) and may incur cost.`,
    { modal: true },
    "Analyze"
  );
  if (confirm !== "Analyze") {
    return;
  }
  logger.revealOnce();
  logger.info(`Batch analysis started · ${pending.length} fragment(s).`);
  // Claim the whole batch so a tree click on a pending fragment while the batch
  // runs doesn't start a duplicate analysis for it.
  for (const fragment of pending) {
    fragmentsInFlight.add(fragment.id);
  }
  try {
    await runBatch(context, logger, index, pending);
  } finally {
    for (const fragment of pending) {
      fragmentsInFlight.delete(fragment.id);
    }
  }
}

async function runBatch(
  context: vscode.ExtensionContext,
  logger: Logger,
  index: PromptIndexStore,
  pending: Fragment[]
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Prompt Radar: analyzing ${pending.length} prompt(s)…`,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const provider = await createProvider(context.secrets, logger);
        const detector = new Detector(
          context.extensionUri,
          provider,
          logger,
          readLlmOptions()
        );
        const maxConcurrent = vscode.workspace
          .getConfiguration("promptRadar")
          .get<number>("maxConcurrent", 2);
        const outcome = await analyzeFragments({
          fragments: pending,
          detector,
          index,
          maxConcurrent,
          progress,
          token,
          logger,
        });
        if (outcome.providerError) {
          await reportError(outcome.providerError, logger);
          return;
        }
        summaryProvider?.clearError();
        logger.info(
          `Batch analysis done · analyzed=${outcome.analyzed} failed=${outcome.failed}${
            outcome.cancelled ? " (cancelled)" : ""
          }.`
        );
        vscode.window.showInformationMessage(
          `Prompt Radar: analyzed ${outcome.analyzed}, ${outcome.failed} failed${
            outcome.cancelled ? " (cancelled)" : ""
          }.`
        );
      } catch (err) {
        await reportError(err, logger);
      }
    }
  );
}

async function analyzeSelection(
  context: vscode.ExtensionContext,
  logger: Logger,
  index: PromptIndexStore,
  radar: RadarPanel
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage("Open a file and select some text first.");
    return;
  }
  const selection = editor.selection;
  const text = editor.document.getText(selection);
  if (text.trim().length === 0) {
    await vscode.window.showWarningMessage("Select some prompt text to analyze.");
    return;
  }

  logger.revealOnce();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Prompt Radar: analyzing…",
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      try {
        const { result, model } = await runDetector(
          context,
          logger,
          text,
          controller.signal
        );

        const file = vscode.workspace.asRelativePath(editor.document.uri, false);
        const startOffset = editor.document.offsetAt(selection.start);
        const endOffset = editor.document.offsetAt(selection.end);
        const now = new Date().toISOString();
        const fragment: Fragment = {
          id: fragmentId(file, startOffset, endOffset),
          file,
          span: {
            char_start: startOffset,
            char_end: endOffset,
            line_start: selection.start.line,
            line_end: selection.end.line,
          },
          artifactType: result.artifact_type,
          artifactText: text,
          artifactTextSha256: sha256(text),
          confidence: 1,
          toolOutput: result,
          model,
          scannedAt: now,
          analyzedAt: now,
        };
        index.upsert(fragment);
        radar.showFragment(fragment.id);
      } catch (err) {
        if (token.isCancellationRequested) {
          return;
        }
        await reportError(err, logger);
      }
    }
  );
}

async function scanWorkspace(
  logger: Logger,
  index: PromptIndexStore
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    await vscode.window.showWarningMessage("Prompt Radar: open a folder to scan.");
    return;
  }
  logger.revealOnce();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Prompt Radar: scanning workspace…",
      cancellable: true,
    },
    async (progress, token) => {
      const scanner = new Scanner(logger);
      const { fragments, capped } = await scanner.scanWorkspace(progress, token);
      if (token.isCancellationRequested) {
        logger.info("Scan cancelled.");
        return;
      }
      index.replaceAll(mergeAnalysis(index, fragments));
      vscode.window.showInformationMessage(
        `Prompt Radar: found ${index.all().length} prompt fragment(s) in ${index.files().length} file(s).` +
          (capped ? " (file cap reached — see the Prompt Radar output channel)" : "")
      );
    }
  );
}

async function rescanCurrentFile(
  logger: Logger,
  index: PromptIndexStore
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage("Prompt Radar: open a file to rescan.");
    return;
  }
  const scanner = new Scanner(logger);
  const fresh = await scanner.scanFile(editor.document.uri);
  const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
  index.replaceFile(rel, mergeAnalysis(index, fresh));
  vscode.window.showInformationMessage(
    `Prompt Radar: ${fresh.length} fragment(s) detected in ${rel}.`
  );
}

// Add the current editor selection to the detected-prompts index as a fragment
// (without analyzing it) — for prompts the scanner missed or split wrongly.
async function addFragmentFromSelection(index: PromptIndexStore): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage("Open a file and select prompt text first.");
    return;
  }
  const selection = editor.selection;
  const text = editor.document.getText(selection);
  if (text.trim().length === 0) {
    await vscode.window.showWarningMessage("Select the prompt text to add.");
    return;
  }
  const file = vscode.workspace.asRelativePath(editor.document.uri, false);
  const startOffset = editor.document.offsetAt(selection.start);
  const endOffset = editor.document.offsetAt(selection.end);
  const fragment: Fragment = {
    id: fragmentId(file, startOffset, endOffset),
    file,
    span: {
      char_start: startOffset,
      char_end: endOffset,
      line_start: selection.start.line,
      line_end: selection.end.line,
    },
    artifactType: "embedded_prompt",
    artifactText: text,
    artifactTextSha256: sha256(text),
    confidence: 1,
    scannedAt: new Date().toISOString(),
  };
  index.upsert(fragment);
  const pick = await vscode.window.showInformationMessage(
    `Prompt Radar: added a fragment from your selection (${text.length} chars).`,
    "Analyze now"
  );
  if (pick === "Analyze now") {
    await vscode.commands.executeCommand("promptRadar.openFragment", fragment.id);
  }
}

// Open a detected fragment: reveal it in the editor, open the radar webview, and
// analyze it if it hasn't been analyzed yet.
async function openFragment(
  context: vscode.ExtensionContext,
  logger: Logger,
  index: PromptIndexStore,
  radar: RadarPanel,
  id: string
): Promise<void> {
  const fragment = index.get(id);
  if (!fragment) {
    return;
  }
  logger.info(
    `openFragment ${fragment.file} (analyzed=${!!fragment.toolOutput}, failed=${!!fragment.failed})`
  );

  radar.showFragment(id);

  // Decide whether to analyze and claim the fragment *synchronously* — before
  // any await — so a rapid second click (double-click) doesn't start a duplicate
  // analysis for the same fragment.
  const willAnalyze =
    !fragment.toolOutput && !fragment.failed && !fragmentsInFlight.has(id);
  if (willAnalyze) {
    fragmentsInFlight.add(id);
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    try {
      const uri = vscode.Uri.joinPath(root, fragment.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
      });
      const start = doc.positionAt(fragment.span.char_start);
      const end = doc.positionAt(fragment.span.char_end);
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(
        new vscode.Range(start, end),
        vscode.TextEditorRevealType.InCenter
      );
    } catch (err) {
      logger.verbose(`openFragment could not open ${fragment.file}: ${errorMessage(err)}`);
    }
  }

  if (willAnalyze) {
    try {
      await analyzeFragment(context, logger, index, fragment);
    } finally {
      fragmentsInFlight.delete(id);
    }
    // Bring the panel forward with the completed analysis. The index change
    // already re-renders its content; this also surfaces the panel (the editor
    // reveal above moved focus away while analysis was running).
    radar.showFragment(id);
  }
}

// Analyze a single fragment via the detector and store the result (or a failed
// marker) on the index.
async function analyzeFragment(
  context: vscode.ExtensionContext,
  logger: Logger,
  index: PromptIndexStore,
  fragment: Fragment
): Promise<void> {
  logger.revealOnce();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Prompt Radar: analyzing fragment…",
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        const { result, model } = await runDetector(
          context,
          logger,
          fragment.artifactText,
          controller.signal
        );
        index.upsert({
          ...fragment,
          artifactType: result.artifact_type,
          toolOutput: result,
          model,
          analyzedAt: new Date().toISOString(),
          failed: false,
        });
        summaryProvider?.clearError();
      } catch (err) {
        if (token.isCancellationRequested) {
          return;
        }
        if (err instanceof DetectorError) {
          index.upsert({
            ...fragment,
            failed: true,
            analyzedAt: new Date().toISOString(),
          });
        }
        await reportError(err, logger);
      }
    }
  );
}

/** Carry over prior analysis when a re-scanned fragment is byte-identical. */
function mergeAnalysis(index: PromptIndexStore, fresh: Fragment[]): Fragment[] {
  return fresh.map((fragment) => {
    const existing = index.get(fragment.id);
    if (
      existing?.toolOutput &&
      existing.artifactTextSha256 === fragment.artifactTextSha256
    ) {
      return {
        ...fragment,
        toolOutput: existing.toolOutput,
        model: existing.model,
        analyzedAt: existing.analyzedAt,
        failed: existing.failed,
      };
    }
    // Not in the live index (e.g. after "Clear Detected Prompts"): re-attach
    // any cached analysis whose fragment text is unchanged.
    const cached = index.takeCachedAnalysis(
      fragment.id,
      fragment.artifactTextSha256
    );
    if (cached) {
      return {
        ...fragment,
        toolOutput: cached.toolOutput,
        model: cached.model,
        analyzedAt: cached.analyzedAt,
      };
    }
    return fragment;
  });
}

async function runDetector(
  context: vscode.ExtensionContext,
  logger: Logger,
  artifact: string,
  signal: AbortSignal
): Promise<{ result: DetectorJSON; model?: string }> {
  const provider = await createProvider(context.secrets, logger);
  const detector = new Detector(
    context.extensionUri,
    provider,
    logger,
    readLlmOptions()
  );
  const result = await detector.analyze(artifact, signal);
  return { result, model: detector.model };
}

async function reportError(err: unknown, logger: Logger): Promise<void> {
  logger.revealOnce();
  if (err instanceof ProviderError) {
    logger.error(`provider (${err.kind}): ${err.message}`);
    summaryProvider?.showError(err.kind, err.message);
    const action = bannerActionForKind(err.kind);
    if (action === "openSettings") {
      const pick = await vscode.window.showErrorMessage(
        `Prompt Radar: ${err.message}`,
        "Configure API Key",
        "Open Settings"
      );
      if (pick === "Configure API Key") {
        await vscode.commands.executeCommand("promptRadar.configureApiKey");
      } else if (pick === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          SETTINGS_QUERY
        );
      }
      return;
    }
    await vscode.window.showErrorMessage(`Prompt Radar: ${err.message}`);
    return;
  }

  if (err instanceof DetectorError) {
    logger.error("detector returned malformed output.");
    await vscode.window.showErrorMessage(
      "Prompt Radar: the model returned malformed output (see the Prompt Radar output channel)."
    );
    return;
  }

  logger.error(errorMessage(err));
  await vscode.window.showErrorMessage(`Prompt Radar: ${errorMessage(err)}`);
}
