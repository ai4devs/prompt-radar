import * as vscode from "vscode";

// Thin wrapper over the "Prompt Radar" output channel. `info`/`error` always
// log; `verbose` logs only when promptRadar.log.verbose is on. The first time
// the user runs analysis we surface the channel so activity is visible.
export class Logger {
  private revealed = false;

  constructor(private readonly channel: vscode.OutputChannel) {}

  private stamp(): string {
    // HH:mm:ss.SSS
    return new Date().toISOString().slice(11, 23);
  }

  info(message: string): void {
    this.channel.appendLine(`[${this.stamp()}] ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[${this.stamp()}] ERROR  ${message}`);
  }

  verbose(message: string): void {
    if (this.isVerbose()) {
      this.channel.appendLine(`[${this.stamp()}]   · ${message}`);
    }
  }

  /** Surface the output channel once (e.g. on the first analysis). */
  revealOnce(): void {
    if (!this.revealed) {
      this.revealed = true;
      this.channel.show(true);
    }
  }

  /** Raw passthrough for multi-line dumps (e.g. malformed responses). */
  appendLine(message: string): void {
    this.channel.appendLine(message);
  }

  private isVerbose(): boolean {
    return vscode.workspace
      .getConfiguration("promptRadar")
      .get<boolean>("log.verbose", false);
  }
}
