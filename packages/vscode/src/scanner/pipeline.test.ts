import { test, before } from "node:test";
import assert from "node:assert/strict";
import { prefilter } from "./prefilter";
import { extractForFile } from "./pipeline";
import { loadTestRuntime } from "./ast/testWasm";
import type { AstRuntime } from "./ast/runtime";

let runtime: AstRuntime;

before(async () => {
  const rt = await loadTestRuntime(["python"]);
  assert.ok(rt);
  runtime = rt!;
});

const PY = `import openai
prompt = f"You are a helpful assistant. Answer the user accurately and kindly."
`;
const OPTS = { minConfidence: 0.6, scope: "auto" as const, maxChars: 16000 };

test("pipeline: with runtime → AST path", () => {
  const r = extractForFile("a.py", PY, prefilter("a.py", PY), OPTS, runtime);
  assert.equal(r.path, "ast");
  assert.equal(r.fragments.length, 1);
});

test("pipeline: no runtime → heuristic path", () => {
  const r = extractForFile("a.py", PY, prefilter("a.py", PY), OPTS, undefined);
  assert.equal(r.path, "heuristic");
  assert.equal(r.fragments.length, 1);
});

test("pipeline: AST success with zero fragments does NOT fall back", () => {
  // A suspect file (telltale content in a comment) with no actual prompt string.
  const src = `import openai\n# You are reading a comment, not a prompt string at all here\nx = 2\n`;
  const r = extractForFile("a.py", src, prefilter("a.py", src), OPTS, runtime);
  assert.equal(r.path, "ast");
  assert.equal(r.fragments.length, 0);
});

test("pipeline: a throwing spec falls back to heuristics", () => {
  // A runtime whose parserFor returns a handle whose parser throws on parse.
  const broken: AstRuntime = {
    parserFor: () => ({
      // minimal stub: parse throws
      parser: {
        parse() {
          throw new Error("boom");
        },
      } as never,
      language: {} as never,
    }),
    dispose() {},
  };
  const r = extractForFile("a.py", PY, prefilter("a.py", PY), OPTS, broken);
  assert.equal(r.path, "heuristic");
  assert.equal(r.fragments.length, 1);
});

test("pipeline: standalone prompt file → standalone path", () => {
  const content = "You are a translator. Translate EN→FR for the user.";
  const r = extractForFile(
    "x.prompt",
    content,
    prefilter("x.prompt", content),
    OPTS,
    runtime
  );
  assert.equal(r.path, "standalone");
  assert.equal(r.fragments.length, 1);
  assert.equal(r.fragments[0].artifactType, "prompt_template");
});

test("pipeline: an unsupported language with no grammar uses heuristics", () => {
  // .rb has no AST grammar wired → heuristic path (which yields nothing here).
  const rb = `# ruby\nputs "hello world this is plain text"\n`;
  const r = extractForFile("a.rb", rb, prefilter("a.rb", rb), OPTS, runtime);
  assert.equal(r.path, "heuristic");
});
