import * as vscode from "vscode";
import type { Fragment } from "../model/types";
import type { Logger } from "../util/logger";
import { fragmentId, sha256 } from "../util/hash";
import {
  extractCodeUnits,
  extractFragments,
  type CodeScope,
  type RawFragment,
} from "./extractor";
import { prefilter } from "./prefilter";

// Walks the workspace (Tier-1 prefilter + Tier-2 heuristic extraction) and
// produces Fragments. No LLM calls. Honors promptRadar.scan.exclude,
// promptRadar.scan.languages, a built-in base-exclude list, and (best-effort)
// the workspace .gitignore.

const LANGUAGE_EXTS: Record<string, string[]> = {
  python: ["py", "pyi"],
  typescript: ["ts", "tsx"],
  javascript: ["js", "jsx", "mjs", "cjs"],
};

// Always excluded (generated/build/vendor output), unioned with user excludes +
// .gitignore so clearing the setting can't reintroduce build noise.
const BASE_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.prompt-radar/**",
  "**/.nuxt/**",
  "**/.next/**",
  "**/.output/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.map",
  // Our own session-log exports (default save location is the workspace root);
  // they contain prompt text and would otherwise be re-detected as prompts.
  "**/prompt-radar-session-*.json",
];

const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 5000;
const MAX_LINE_LEN = 5000; // skip minified/generated files
const MAX_ARTIFACT_CHARS = 16_000; // cap on the code unit sent to the detector

export interface ScanResult {
  fragments: Fragment[];
  filesScanned: number;
  capped: boolean;
}

export class Scanner {
  constructor(private readonly logger: Logger) {}

  async scanWorkspace(
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken
  ): Promise<ScanResult> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return { fragments: [], filesScanned: 0, capped: false };
    }
    const startedMs = Date.now();

    const cfg = vscode.workspace.getConfiguration("promptRadar");
    const languages = cfg.get<string[]>("scan.languages", [
      "python",
      "typescript",
      "javascript",
    ]);
    const minConfidence = cfg.get<number>("scan.minConfidence", 0.6);
    const codeScope = cfg.get<CodeScope>("scan.codeScope", "auto");
    const userExcludes = cfg.get<string[]>("scan.exclude", []);
    const gitExcludes = await this.gitignoreGlobs(root);
    const excludeGlob = toBraceGlob([
      ...BASE_EXCLUDES,
      ...userExcludes,
      ...gitExcludes,
    ]);

    const codeExts = languages.flatMap((l) => LANGUAGE_EXTS[l] ?? []);
    const includeGlobs = [
      `**/*.{${[...codeExts, "prompt", "jinja", "j2", "tmpl", "template"].join(",")}}`,
      `**/*.{yaml,yml,json}`,
      `**/*.{agent,prompt,system}.md`,
    ];

    this.logger.info(
      `Scan started · languages=[${languages.join(", ")}] · minConfidence=${minConfidence}`
    );
    this.logger.verbose(`exclude: ${excludeGlob ?? "(none)"}`);

    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const include of includeGlobs) {
      if (token?.isCancellationRequested) break;
      const found = await vscode.workspace.findFiles(
        include,
        excludeGlob,
        MAX_FILES,
        token
      );
      for (const uri of found) {
        if (!seen.has(uri.fsPath)) {
          seen.add(uri.fsPath);
          uris.push(uri);
        }
      }
    }
    const capped = uris.length >= MAX_FILES;
    if (capped) {
      this.logger.info(`file cap of ${MAX_FILES} reached — some files not scanned.`);
    }

    const fragments: Fragment[] = [];
    let filesScanned = 0;
    let suspectFiles = 0;
    const total = uris.length;

    for (let idx = 0; idx < uris.length; idx++) {
      if (token?.isCancellationRequested) break;
      const uri = uris[idx];
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (idx % 25 === 0) {
        progress?.report({
          message: `${idx}/${total} files…`,
          increment: total ? (25 / total) * 100 : 0,
        });
      }
      const result = await this.scanUri(uri, rel, minConfidence, codeScope);
      if (result) {
        filesScanned++;
        if (result.length > 0) {
          suspectFiles++;
          fragments.push(...result);
        }
      }
    }

    this.logger.info(
      `Scan complete · ${fragments.length} fragment(s) from ${suspectFiles} file(s) · ` +
        `${total} candidates read · ${Date.now() - startedMs}ms`
    );
    return { fragments, filesScanned, capped };
  }

  async scanFile(uri: vscode.Uri): Promise<Fragment[]> {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const cfg = vscode.workspace.getConfiguration("promptRadar");
    const minConfidence = cfg.get<number>("scan.minConfidence", 0.6);
    const codeScope = cfg.get<CodeScope>("scan.codeScope", "auto");
    return (await this.scanUri(uri, rel, minConfidence, codeScope)) ?? [];
  }

  private async scanUri(
    uri: vscode.Uri,
    rel: string,
    minConfidence: number,
    codeScope: CodeScope
  ): Promise<Fragment[] | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        this.logger.verbose(`skip ${rel}: too large (${stat.size} bytes)`);
        return undefined;
      }
      const content = new TextDecoder("utf-8").decode(
        await vscode.workspace.fs.readFile(uri)
      );
      if (longestLine(content) > MAX_LINE_LEN) {
        this.logger.verbose(`skip ${rel}: looks minified/generated`);
        return undefined;
      }

      const pre = prefilter(rel, content);
      if (!pre.suspect) {
        return undefined;
      }
      // Standalone prompt files and prompt-shaped config keep their dedicated
      // extraction; source code uses code-unit extraction (whole-file / per
      // enclosing function / granular) per promptRadar.scan.codeScope.
      const raw =
        pre.standalone || pre.configPrompt
          ? extractFragments(rel, content, pre, minConfidence)
          : extractCodeUnits(rel, content, pre, {
              minConfidence,
              scope: codeScope,
              maxChars: MAX_ARTIFACT_CHARS,
            });
      if (raw.length > 0) {
        this.logger.verbose(
          `${rel}: ${raw.length} unit(s) [${pre.reasons.join(", ")}]`
        );
      }
      return raw.map((r) => this.toFragment(rel, r));
    } catch (err) {
      this.logger.verbose(
        `skip ${rel}: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  private toFragment(file: string, raw: RawFragment): Fragment {
    return {
      id: fragmentId(file, raw.char_start, raw.char_end),
      file,
      span: {
        char_start: raw.char_start,
        char_end: raw.char_end,
        line_start: raw.line_start,
        line_end: raw.line_end,
      },
      artifactType: raw.artifactType,
      artifactText: raw.text,
      artifactTextSha256: sha256(raw.text),
      confidence: raw.confidence,
      scannedAt: new Date().toISOString(),
    };
  }

  private async gitignoreGlobs(root: vscode.Uri): Promise<string[]> {
    try {
      const text = new TextDecoder("utf-8").decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ".gitignore"))
      );
      const globs: string[] = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith("!")) {
          continue;
        }
        const pattern = line.replace(/^\//, "").replace(/\/$/, "");
        if (!pattern || pattern.includes("**")) {
          continue;
        }
        globs.push(`**/${pattern}`, `**/${pattern}/**`);
      }
      return globs;
    } catch {
      return [];
    }
  }
}

function longestLine(content: string): number {
  let max = 0;
  let cur = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      if (cur > max) max = cur;
      cur = 0;
    } else {
      cur++;
    }
  }
  return Math.max(max, cur);
}

function toBraceGlob(patterns: string[]): string | undefined {
  const cleaned = [...new Set(patterns.filter((p) => p.trim().length > 0))];
  if (cleaned.length === 0) return undefined;
  if (cleaned.length === 1) return cleaned[0];
  return `{${cleaned.join(",")}}`;
}
