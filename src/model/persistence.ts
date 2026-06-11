import * as vscode from "vscode";

// Persistence helpers for the `.prompt-radar/` directory at the workspace root
// (spec §8.1). When no folder is open, the stores run in-memory only.

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function promptRadarDir(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, ".prompt-radar");
}

export async function readJsonFile<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as T;
  } catch {
    return undefined; // missing or corrupt → treat as empty
  }
}

export async function writeJsonFile(uri: vscode.Uri, data: unknown): Promise<void> {
  const dir = vscode.Uri.joinPath(uri, "..");
  await vscode.workspace.fs.createDirectory(dir);
  const text = JSON.stringify(data, null, 2);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}
