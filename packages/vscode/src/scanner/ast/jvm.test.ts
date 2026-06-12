import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadTestRuntime } from "./testWasm";
import { SPECS } from "./specs";
import { astExtractHits } from "./extract";
import type { AstLangId, AstRuntime } from "./runtime";

let runtime: AstRuntime;

before(async () => {
  const rt = await loadTestRuntime(["java", "csharp"]);
  assert.ok(rt);
  runtime = rt!;
});

function hits(lang: AstLangId, content: string, hasSdkImport = true) {
  const handle = runtime.parserFor(lang);
  assert.ok(handle, `grammar ${lang} loaded`);
  const out = astExtractHits(content, handle!, SPECS[lang], {
    minConfidence: 0.6,
    hasSdkImport,
  });
  for (const f of out) {
    assert.equal(content.slice(f.char_start, f.char_end), f.text, "verbatim slice");
  }
  return out;
}

// ── Java ─────────────────────────────────────────────────────────────────────

test("java: text-block prompt-named binding is detected", () => {
  const src = `class A {
  String review(String diff) {
    String systemPrompt = """
        You are a meticulous reviewer. Be concise and specific.
        """;
    return client.prompt(systemPrompt).user(diff).call().content();
  }
}`;
  const h = hits("java", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /You are a meticulous reviewer/);
  assert.ok(!h[0].text.includes('"""'), "text-block delimiters excluded from span");
});

test("java: @SystemMessage annotation argument is detected", () => {
  const src = `interface Assistant {
  @SystemMessage("You are a helpful assistant that responds only in JSON.")
  String chat(String userMessage);
}`;
  const h = hits("java", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /responds only in JSON/);
});

test("java: direct string argument to .system() is detected", () => {
  const src = `class A {
  void run() {
    client.prompt().system("You are a terse assistant. Keep replies short.").call();
  }
}`;
  const h = hits("java", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /terse assistant/);
});

test("java: a plain non-prompt string is ignored", () => {
  const src = `class A {
  String status() {
    return "The service is currently running and healthy at this time.";
  }
}`;
  // no SDK import, no prompt binding/call/annotation/you-are signal
  assert.equal(hits("java", src, false).length, 0);
});

// ── C# ───────────────────────────────────────────────────────────────────────

test("c#: verbatim prompt-named binding is detected", () => {
  const src = `class A {
  string Run(Kernel k) {
    string prompt = @"You are a translator. Translate the user's text to French.";
    return k.InvokePromptAsync(prompt);
  }
}`;
  const h = hits("csharp", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /You are a translator/);
  assert.ok(!h[0].text.includes('@"'), "verbatim prefix excluded");
});

test("c#: raw string literal prompt-named field is detected", () => {
  const src = `class A {
  string System = """
      You are a strict JSON formatter. Output only valid JSON.
      """;
}`;
  const h = hits("csharp", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /strict JSON formatter/);
  assert.ok(!h[0].text.includes('"""'), "raw delimiters excluded");
});

test("c#: AddSystemMessage interpolated argument is detected", () => {
  const src = `class A {
  void Build(ChatHistory history, string topic) {
    history.AddSystemMessage($"You are an expert on {topic}. Answer briefly.");
  }
}`;
  const h = hits("csharp", src);
  assert.equal(h.length, 1);
  assert.match(h[0].text, /You are an expert on \{topic\}/);
  assert.ok(!h[0].text.startsWith("$"), "interpolation prefix excluded");
});

test("c#: a plain non-prompt string is ignored", () => {
  const src = `class A {
  string Index() {
    var message = "Welcome to our website. Browse the catalog to find products.";
    return message;
  }
}`;
  assert.equal(hits("csharp", src, false).length, 0);
});
