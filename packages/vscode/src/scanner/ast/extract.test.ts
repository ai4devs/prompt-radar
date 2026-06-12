import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadTestRuntime } from "./testWasm";
import { SPECS } from "./specs";
import { astExtractHits } from "./extract";
import type { AstLangId, AstRuntime } from "./runtime";

let runtime: AstRuntime;

before(async () => {
  const rt = await loadTestRuntime([
    "python",
    "javascript",
    "typescript",
    "tsx",
  ]);
  assert.ok(rt);
  runtime = rt!;
});

function hits(
  lang: AstLangId,
  content: string,
  hasSdkImport = true
): ReturnType<typeof astExtractHits> {
  const handle = runtime.parserFor(lang);
  assert.ok(handle, `grammar ${lang} loaded`);
  const out = astExtractHits(content, handle!, SPECS[lang], {
    minConfidence: 0.6,
    hasSdkImport,
  });
  for (const f of out) {
    assert.equal(content.slice(f.char_start, f.char_end), f.text, "verbatim slice");
    assert.ok(f.confidence >= 0 && f.confidence <= 1, "confidence in range");
    assert.ok(f.line_start <= f.line_end, "line order");
  }
  return out;
}

// ── Python ───────────────────────────────────────────────────────────────────

test("py: f-string with interpolation, prompt-named binding", () => {
  const src = `import openai\nprompt = f"You are {role}. Answer the user accurately and concisely."`;
  const h = hits("python", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /^You are \{role\}\./);
  assert.ok(!h[0].text.includes('f"'), "span excludes the prefix and quote");
});

test("py: message dict content value is detected, role value is not", () => {
  const src = `import openai\nmsgs = [{"role": "system", "content": "You are a terse code reviewer. Be concise."}]`;
  const h = hits("python", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /terse code reviewer/);
});

test("py: string inside a comment / a URL → 0", () => {
  const src = `import openai\n# You are tempted to flag this comment but it is not a string\nurl = "https://example.com/openai/v1/chat/completions/endpoint"`;
  assert.equal(hits("python", src).length, 0);
});

test("py: PromptTemplate.from_template argument is detected", () => {
  const src = `from langchain_core.prompts import PromptTemplate\ntpl = PromptTemplate.from_template("Summarize the following text in one short sentence.")`;
  const h = hits("python", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /Summarize the following/);
});

// ── JS / TS / TSX ────────────────────────────────────────────────────────────

test("js: message array template-literal content is detected", () => {
  const src = [
    'import OpenAI from "openai";',
    "const r = await client.chat.completions.create({",
    "  messages: [{ role: 'system', content: `You are a terse code reviewer. Be concise.` }],",
    "});",
  ].join("\n");
  const h = hits("javascript", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /terse code reviewer/);
});

test("js: tagged template with telltale content is detected; SQL tag is not", () => {
  const good = "const greeting = dedent`You are welcome here, friend. Stay a while.`;";
  assert.equal(hits("javascript", good).length, 1);
  const sql = "const q = sql`SELECT id, name FROM users WHERE active = true`;";
  assert.equal(hits("javascript", sql).length, 0);
});

test("ts: class field with a prompt-named binding is detected", () => {
  const src = [
    'import OpenAI from "openai";',
    "class Reviewer {",
    "  systemPrompt = `You are strict. Output only valid JSON, nothing else.`;",
    "}",
  ].join("\n");
  const h = hits("typescript", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /Output only valid JSON/);
});

test("tsx: prompt-ish JSX attribute is detected, plain attribute is not", () => {
  const src =
    'const e = <Agent system={`You are concise. Keep every answer short.`} label="save the file" />;';
  const h = hits("tsx", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /Keep every answer short/);
});
