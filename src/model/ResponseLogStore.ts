import * as vscode from "vscode";
import type { Decision, MissedSmell, Response, ResponseLog } from "./types";
import { Debouncer } from "../util/debounce";
import {
  promptRadarDir,
  readJsonFile,
  workspaceRoot,
  writeJsonFile,
} from "./persistence";
import { newSessionId } from "../util/hash";

interface ResponseFileV1 {
  version: 1;
  sessionId: string;
  startedAt: string;
  responses: Record<string, Record<string, Response>>;
  missedSmells: Record<string, MissedSmell[]>;
}

function freshLog(): ResponseLog {
  return {
    sessionId: newSessionId(),
    startedAt: new Date().toISOString(),
    responses: new Map(),
    missedSmells: new Map(),
  };
}

// In-memory ResponseLog with debounced persistence to
// .prompt-radar/responses.json (spec §8.1).
export class ResponseLogStore implements vscode.Disposable {
  private log: ResponseLog = freshLog();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly debouncer = new Debouncer(() => this.persist(), 500);
  private readonly root = workspaceRoot();

  async load(): Promise<void> {
    if (!this.root) {
      return;
    }
    const uri = vscode.Uri.joinPath(promptRadarDir(this.root), "responses.json");
    const data = await readJsonFile<ResponseFileV1>(uri);
    if (!data) {
      return;
    }
    this.log.sessionId = data.sessionId ?? this.log.sessionId;
    this.log.startedAt = data.startedAt ?? this.log.startedAt;
    this.log.responses = new Map(
      Object.entries(data.responses ?? {}).map(([fid, smells]) => [
        fid,
        new Map(Object.entries(smells)),
      ])
    );
    this.log.missedSmells = new Map(Object.entries(data.missedSmells ?? {}));
    this.emitter.fire();
  }

  get sessionId(): string {
    return this.log.sessionId;
  }

  get startedAt(): string {
    return this.log.startedAt;
  }

  responsesFor(fragmentId: string): Response[] {
    return [...(this.log.responses.get(fragmentId)?.values() ?? [])];
  }

  responseFor(fragmentId: string, smellId: string): Response | undefined {
    return this.log.responses.get(fragmentId)?.get(smellId);
  }

  /** Record (or revise) a response. `shownAt` is preserved across revisions and
   *  `changedCount` is incremented each time an existing response changes. */
  setResponse(
    fragmentId: string,
    input: { smellId: string; decision: Decision; rationale?: string; shownAt?: string }
  ): void {
    let smells = this.log.responses.get(fragmentId);
    if (!smells) {
      smells = new Map();
      this.log.responses.set(fragmentId, smells);
    }
    const existing = smells.get(input.smellId);
    const now = new Date().toISOString();
    smells.set(input.smellId, {
      smellId: input.smellId,
      decision: input.decision,
      rationale: input.rationale,
      shownAt: existing?.shownAt ?? input.shownAt ?? now,
      respondedAt: now,
      changedCount: existing ? existing.changedCount + 1 : 0,
    });
    this.emitter.fire();
    this.debouncer.schedule();
  }

  missedSmellsFor(fragmentId: string): MissedSmell[] {
    return this.log.missedSmells.get(fragmentId) ?? [];
  }

  addMissedSmell(fragmentId: string, smell: MissedSmell): void {
    const arr = this.log.missedSmells.get(fragmentId) ?? [];
    arr.push(smell);
    this.log.missedSmells.set(fragmentId, arr);
    this.emitter.fire();
    this.debouncer.schedule();
  }

  /** Read-only view of the whole log (for export). */
  snapshot(): ResponseLog {
    return this.log;
  }

  clear(): void {
    this.log = freshLog();
    this.emitter.fire();
    this.debouncer.schedule();
  }

  private async persist(): Promise<void> {
    if (!this.root) {
      return;
    }
    const uri = vscode.Uri.joinPath(promptRadarDir(this.root), "responses.json");
    const data: ResponseFileV1 = {
      version: 1,
      sessionId: this.log.sessionId,
      startedAt: this.log.startedAt,
      responses: Object.fromEntries(
        [...this.log.responses].map(([fid, smells]) => [
          fid,
          Object.fromEntries(smells),
        ])
      ),
      missedSmells: Object.fromEntries(this.log.missedSmells),
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
