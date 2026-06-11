import { createHash, randomUUID } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function newSessionId(): string {
  return randomUUID();
}

/** Stable fragment id (spec §8.1): sha256(file + char_start + char_end). */
export function fragmentId(
  file: string,
  charStart: number,
  charEnd: number
): string {
  return sha256(`${file}:${charStart}:${charEnd}`);
}
