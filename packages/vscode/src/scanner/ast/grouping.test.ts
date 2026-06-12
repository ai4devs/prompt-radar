import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadTestRuntime } from "./testWasm";
import { SPECS } from "./specs";
import { astExtract } from "./extract";
import type { AstLangId, AstRuntime } from "./runtime";
import type { CodeScope } from "../extractor";

let runtime: AstRuntime;

before(async () => {
  const rt = await loadTestRuntime(["python", "typescript"]);
  assert.ok(rt);
  runtime = rt!;
});

function units(lang: AstLangId, content: string, scope: CodeScope = "auto") {
  const handle = runtime.parserFor(lang);
  assert.ok(handle);
  const out = astExtract(content, handle!, SPECS[lang], {
    minConfidence: 0.6,
    hasSdkImport: true,
    scope,
    maxChars: 16000,
  });
  for (const u of out) {
    assert.equal(content.slice(u.char_start, u.char_end), u.text, "verbatim slice");
  }
  return out;
}

const SINGLE_MODULE_PROMPT = `import openai

client = openai.OpenAI()
prompt = f"You are a helpful assistant. Answer the user politely and accurately."
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": prompt}],
)
`;

test("py auto: single module-level prompt → one whole-file unit", () => {
  const u = units("python", SINGLE_MODULE_PROMPT);
  assert.equal(u.length, 1);
  assert.equal(u[0].text, SINGLE_MODULE_PROMPT);
});

const SINGLE_FN_WITH_DOCSTRING = `"""Extracts structured fields from free-text invoices."""

import openai

client = openai.OpenAI()


def extract(invoice_text: str) -> str:
    prompt = (
        "Return the invoice data as JSON. "
        "Only include line items above 0.34 confidence. "
        "Text: " + invoice_text
    )
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.choices[0].message.content
`;

test("py auto: in-function prompt → the function block, not the module docstring", () => {
  const u = units("python", SINGLE_FN_WITH_DOCSTRING);
  assert.equal(u.length, 1);
  assert.match(u[0].text, /def extract/);
  assert.match(u[0].text, /Return the invoice data as JSON/);
  assert.ok(!/Extracts structured fields/.test(u[0].text), "module docstring excluded");
  assert.ok(!/import openai/.test(u[0].text), "imports excluded");
});

const TWO_FUNCTIONS = `import openai

client = openai.OpenAI()


def greet(name):
    prompt = f"You are a friendly greeter. Greet {name} warmly and briefly."
    return client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": prompt}]
    )


def summarize(text):
    instruction = "You are a precise summarizer. Summarize the input in one sentence."
    return client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": instruction + text}]
    )
`;

test("py auto: two functions each with a prompt → one unit per function", () => {
  const u = units("python", TWO_FUNCTIONS);
  assert.equal(u.length, 2);
  const greet = u.find((f) => /friendly greeter/.test(f.text));
  const sum = u.find((f) => /precise summarizer/.test(f.text));
  assert.ok(greet && sum);
  assert.ok(!/precise summarizer/.test(greet!.text), "greet unit excludes the other prompt");
  assert.ok(!/friendly greeter/.test(sum!.text), "summarize unit excludes the other prompt");
  assert.match(greet!.text, /def greet/);
  assert.match(sum!.text, /def summarize/);
});

// JS function grouping replaces the old 6-line-gap heuristic.
const TS_TWO_FUNCTIONS = `import OpenAI from "openai";
const client = new OpenAI();

async function greet(name: string) {
  const prompt = \`You are a friendly greeter. Greet the user warmly and briefly.\`;
  return client.chat.completions.create({ messages: [{ role: "user", content: prompt }] });
}

async function summarize(text: string) {
  const instruction = \`You are a precise summarizer. Summarize the input in one sentence.\`;
  return client.chat.completions.create({ messages: [{ role: "user", content: instruction }] });
}
`;

test("ts auto: two functions each with a prompt → one unit per function", () => {
  const u = units("typescript", TS_TWO_FUNCTIONS);
  assert.equal(u.length, 2);
  const greet = u.find((f) => /friendly greeter/.test(f.text));
  const sum = u.find((f) => /precise summarizer/.test(f.text));
  assert.ok(greet && sum, "both function prompts detected and separated");
  assert.match(greet!.text, /function greet/);
  assert.match(sum!.text, /function summarize/);
  assert.ok(!/precise summarizer/.test(greet!.text));
});

test("ts fragments mode: granular per-string fragments", () => {
  const u = units("typescript", TS_TWO_FUNCTIONS, "fragments");
  assert.equal(u.length, 2);
  assert.ok(!u.some((f) => /function greet/.test(f.text)), "no function bodies");
});
