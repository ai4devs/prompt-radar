import * as vscode from "vscode";
import type { DetectorJSON } from "../detector/schema";
import type { Fragment, PromptIndex } from "./types";
import { Debouncer } from "../util/debounce";
import {
  promptRadarDir,
  readJsonFile,
  workspaceRoot,
  writeJsonFile,
} from "./persistence";

// Analysis carried over an explicit "clear detected prompts" so a later Scan can
// re-attach it to the same fragment (matched by id + artifactTextSha256) without
// re-spending an LLM call. Keyed by fragment id.
interface CachedAnalysis {
  artifactTextSha256: string;
  toolOutput: DetectorJSON;
  model?: string;
  analyzedAt?: string;
}

interface IndexFileV1 {
  version: 1;
  fragments: Fragment[];
  analysisCache?: Array<{ id: string } & CachedAnalysis>;
}

// In-memory PromptIndex with debounced persistence to .prompt-radar/index.json.
export class PromptIndexStore implements vscode.Disposable {
  private index: PromptIndex = { fragments: new Map(), byFile: new Map() };
  private analysisCache = new Map<string, CachedAnalysis>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly debouncer = new Debouncer(() => this.persist(), 500);
  private readonly root = workspaceRoot();

  async load(): Promise<void> {
    if (!this.root) {
      return;
    }
    const uri = vscode.Uri.joinPath(promptRadarDir(this.root), "index.json");
    const data = await readJsonFile<IndexFileV1>(uri);
    if (!data?.fragments) {
      return;
    }
    for (const fragment of data.fragments) {
      this.insert(fragment);
    }
    for (const { id, ...cached } of data.analysisCache ?? []) {
      this.analysisCache.set(id, cached);
    }
    this.emitter.fire();
  }

  private insert(fragment: Fragment): void {
    this.index.fragments.set(fragment.id, fragment);
    const ids = this.index.byFile.get(fragment.file) ?? [];
    if (!ids.includes(fragment.id)) {
      ids.push(fragment.id);
    }
    this.index.byFile.set(fragment.file, ids);
  }

  upsert(fragment: Fragment): void {
    this.insert(fragment);
    this.emitter.fire();
    this.debouncer.schedule();
  }

  /** Replace the entire index (used by a full workspace scan). */
  replaceAll(fragments: Fragment[]): void {
    this.index = { fragments: new Map(), byFile: new Map() };
    for (const fragment of fragments) {
      this.insert(fragment);
    }
    this.emitter.fire();
    this.debouncer.schedule();
  }

  /** Replace all fragments for a file (used by re-scan). Preserves nothing. */
  replaceFile(file: string, fragments: Fragment[]): void {
    for (const id of this.index.byFile.get(file) ?? []) {
      this.index.fragments.delete(id);
    }
    this.index.byFile.delete(file);
    for (const fragment of fragments) {
      this.insert(fragment);
    }
    this.emitter.fire();
    this.debouncer.schedule();
  }

  get(id: string): Fragment | undefined {
    return this.index.fragments.get(id);
  }

  all(): Fragment[] {
    return [...this.index.fragments.values()];
  }

  files(): string[] {
    return [...this.index.byFile.keys()];
  }

  forFile(file: string): Fragment[] {
    const out: Fragment[] = [];
    for (const id of this.index.byFile.get(file) ?? []) {
      const fragment = this.index.fragments.get(id);
      if (fragment) {
        out.push(fragment);
      }
    }
    return out;
  }

  /** Remove a single fragment (e.g. a false positive removed from the tree). */
  remove(id: string): void {
    const fragment = this.index.fragments.get(id);
    if (!fragment) {
      return;
    }
    this.index.fragments.delete(id);
    const ids = (this.index.byFile.get(fragment.file) ?? []).filter(
      (x) => x !== id
    );
    if (ids.length > 0) {
      this.index.byFile.set(fragment.file, ids);
    } else {
      this.index.byFile.delete(fragment.file);
    }
    this.emitter.fire();
    this.debouncer.schedule();
  }

  clear(): void {
    this.index = { fragments: new Map(), byFile: new Map() };
    this.analysisCache.clear();
    this.emitter.fire();
    this.debouncer.schedule();
  }

  /** Remove all detected fragments from the tree but stash their analysis in the
   *  cache, so the next Scan re-detects them with the analysis pre-loaded (for
   *  fragments whose text still matches). Review responses are untouched. */
  clearKeepAnalysis(): void {
    for (const fragment of this.index.fragments.values()) {
      if (fragment.toolOutput) {
        this.analysisCache.set(fragment.id, {
          artifactTextSha256: fragment.artifactTextSha256,
          toolOutput: fragment.toolOutput,
          model: fragment.model,
          analyzedAt: fragment.analyzedAt,
        });
      }
    }
    this.index = { fragments: new Map(), byFile: new Map() };
    this.emitter.fire();
    this.debouncer.schedule();
  }

  /** Pop cached analysis for a re-detected fragment when its text is unchanged.
   *  Consumed on use so a later Clear Analysis cannot resurrect it. */
  takeCachedAnalysis(
    id: string,
    artifactTextSha256: string
  ): { toolOutput: DetectorJSON; model?: string; analyzedAt?: string } | undefined {
    const cached = this.analysisCache.get(id);
    if (!cached || cached.artifactTextSha256 !== artifactTextSha256) {
      return undefined;
    }
    this.analysisCache.delete(id);
    return {
      toolOutput: cached.toolOutput,
      model: cached.model,
      analyzedAt: cached.analyzedAt,
    };
  }

  /** Drop analysis output from every fragment (back to "pending"), keeping the
   *  detected fragments so they can be re-analyzed. */
  clearAnalysis(): void {
    // A true reset of analysis: drop the cache too, so a later Scan does not
    // re-attach stale output.
    const hadCache = this.analysisCache.size > 0;
    this.analysisCache.clear();
    let changed = hadCache;
    for (const [id, fragment] of this.index.fragments) {
      if (fragment.toolOutput || fragment.failed || fragment.analyzedAt) {
        this.index.fragments.set(id, {
          ...fragment,
          toolOutput: undefined,
          analyzedAt: undefined,
          failed: undefined,
        });
        changed = true;
      }
    }
    if (changed) {
      this.emitter.fire();
      this.debouncer.schedule();
    }
  }

  private async persist(): Promise<void> {
    if (!this.root) {
      return;
    }
    const uri = vscode.Uri.joinPath(promptRadarDir(this.root), "index.json");
    const data: IndexFileV1 = {
      version: 1,
      fragments: this.all(),
      analysisCache: [...this.analysisCache].map(([id, cached]) => ({
        id,
        ...cached,
      })),
    };
    await writeJsonFile(uri, data);
  }

  async flush(): Promise<void> {
    await this.debouncer.flush();
  }

  dispose(): void {
    this.debouncer.dispose();
    this.emitter.dispose();
  }
}
