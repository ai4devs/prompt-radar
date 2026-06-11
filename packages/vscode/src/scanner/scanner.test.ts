import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilter } from "./prefilter";
import { extractCodeUnits, extractFragments, type CodeScope } from "./extractor";

function scan(path: string, content: string) {
  // Per-string extraction (used for prefilter/standalone/config/decoy gating).
  return extractFragments(path, content, prefilter(path, content));
}

function units(path: string, content: string, scope: CodeScope = "auto") {
  return extractCodeUnits(path, content, prefilter(path, content), {
    minConfidence: 0.6,
    scope,
    maxChars: 16000,
  });
}

// ── TRUE NEGATIVES (must produce 0) ──────────────────────────────────────────

test("Helm/k8s template YAML under templates/ → 0", () => {
  const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: gateway-server
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
`;
  const path = "infra/helm/charts/commons/templates/gateway-server.yml";
  assert.equal(prefilter(path, yaml).suspect, false);
  assert.equal(scan(path, yaml).length, 0);
});

test("generated Nuxt .mjs (no SDK import) → 0", () => {
  const mjs = `export const handler = async (ctx) => {
  const html = \`<div>\${ctx.title}</div>\`;
  const out = await client.invoke(\`render \${html} now please\`);
  return out;
};
`;
  assert.equal(units("canvas/.nuxt/dev/index.mjs", mjs).length, 0);
});

test("Python mentioning 'openai' only in a string → 0", () => {
  const py = `# integrates with an openai-compatible endpoint
URL = "https://api.example.com/openai/v1/chat"
def call(x):
    return requests.post(URL, json=x)
`;
  assert.equal(prefilter("src/client.py", py).hasSdkImport, false);
  assert.equal(units("src/client.py", py).length, 0);
});

// ── code-scope: auto / file / fragments ──────────────────────────────────────

const SINGLE_MODULE_PROMPT = `import openai

client = openai.OpenAI()
prompt = f"You are a helpful assistant. Answer the user politely and accurately."
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": prompt}],
)
`;

test("auto: single module-level prompt → one whole-file unit", () => {
  const u = units("src/agent.py", SINGLE_MODULE_PROMPT, "auto");
  assert.equal(u.length, 1);
  assert.equal(SINGLE_MODULE_PROMPT.slice(u[0].char_start, u[0].char_end), u[0].text);
  assert.equal(u[0].text, SINGLE_MODULE_PROMPT); // whole file
  assert.match(u[0].text, /You are a helpful assistant/);
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
        messages=[
            {"role": "system", "content": "You extract data."},
            {"role": "user", "content": prompt},
        ],
    )
    return resp.choices[0].message.content
`;

const MODULE_LEVEL_WITH_DOCSTRING = `"""Automated code reviewer built on Anthropic's API."""

import anthropic

client = anthropic.Anthropic()

SYSTEM = """You are an expert reviewer. Be thorough and concise."""


def review(diff: str) -> str:
    return client.messages.create(
        model="claude-3-5-sonnet-latest",
        system=SYSTEM,
        messages=[{"role": "user", "content": diff}],
    )
`;

test("auto: module-level prompt → whole file MINUS the leading docstring", () => {
  const u = units("apps/code_reviewer/review.py", MODULE_LEVEL_WITH_DOCSTRING, "auto");
  assert.equal(u.length, 1);
  assert.equal(
    MODULE_LEVEL_WITH_DOCSTRING.slice(u[0].char_start, u[0].char_end),
    u[0].text
  );
  assert.match(u[0].text, /You are an expert reviewer/);
  assert.ok(
    !/Automated code reviewer built on/.test(u[0].text),
    "leading docstring must be excluded"
  );
});

test("auto: single in-function prompt → the function block, NOT the module docstring", () => {
  const u = units("apps/data_extractor/extract.py", SINGLE_FN_WITH_DOCSTRING, "auto");
  assert.equal(u.length, 1);
  assert.equal(
    SINGLE_FN_WITH_DOCSTRING.slice(u[0].char_start, u[0].char_end),
    u[0].text
  );
  assert.match(u[0].text, /def extract/);
  assert.match(u[0].text, /Return the invoice data as JSON/);
  // module docstring + import must be excluded so they can't bias the analysis
  assert.ok(!/Extracts structured fields/.test(u[0].text));
  assert.ok(!/import openai/.test(u[0].text));
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

test("auto: two functions each with a prompt → one unit per function", () => {
  const u = units("src/agents.py", TWO_FUNCTIONS, "auto");
  assert.equal(u.length, 2, "expected one fragment per function");
  for (const f of u) {
    assert.equal(TWO_FUNCTIONS.slice(f.char_start, f.char_end), f.text);
  }
  const greet = u.find((f) => /friendly greeter/.test(f.text));
  const sum = u.find((f) => /precise summarizer/.test(f.text));
  assert.ok(greet && sum, "both function prompts detected");
  // each unit contains its own prompt and NOT the other's
  assert.ok(!/precise summarizer/.test(greet!.text));
  assert.ok(!/friendly greeter/.test(sum!.text));
  assert.match(greet!.text, /def greet/);
  assert.match(sum!.text, /def summarize/);
});

const MULTIPART_ONE_FN = `import openai

client = openai.OpenAI()


def build(user):
    prompt = (
        "You are an assistant. "
        "Be concise and accurate. "
        f"Answer the user: {user}"
    )
    return client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": prompt}]
    )
`;

test("auto: a multi-part single prompt → one unit that captures ALL parts", () => {
  const u = units("src/build.py", MULTIPART_ONE_FN, "auto");
  assert.equal(u.length, 1);
  // The heuristic alone only flags the "You are" piece; sending the whole
  // function means the other parts are included too (the partial-capture fix).
  assert.match(u[0].text, /You are an assistant/);
  assert.match(u[0].text, /Be concise and accurate/);
  assert.match(u[0].text, /Answer the user/);
});

test("fragments mode: keeps granular per-string fragments", () => {
  const u = units("src/agents.py", TWO_FUNCTIONS, "fragments");
  assert.equal(u.length, 2);
  // granular = the string literal itself, not the enclosing function
  assert.ok(!u.some((f) => /def greet/.test(f.text)));
});

test("file mode: two-function file → a single whole-file unit", () => {
  const u = units("src/agents.py", TWO_FUNCTIONS, "file");
  assert.equal(u.length, 1);
  assert.equal(u[0].text, TWO_FUNCTIONS);
});

test("JS template literal near a call (single prompt) → one whole-file unit", () => {
  const js = [
    'import OpenAI from "openai";',
    "const client = new OpenAI();",
    "const r = await client.chat.completions.create({",
    "  model: 'gpt-4o',",
    "  messages: [{ role: 'system', content: `You are a terse code reviewer. Be concise.` }],",
    "});",
  ].join("\n");
  const u = units("src/review.ts", js, "auto");
  assert.equal(u.length, 1);
  assert.match(u[0].text, /terse code reviewer/);
});

// ── standalone / config / prefilter (unchanged paths) ────────────────────────

test("prompt-shaped YAML → one whole-file fragment (the message array)", () => {
  const yaml = `name: support-agent
messages:
  - role: system
    content: "You are a helpful support agent. Be concise and accurate."
  - role: user
    content: "{{question}}"
`;
  const path = "agents/support.yml";
  assert.equal(prefilter(path, yaml).configPrompt, true);
  const frags = scan(path, yaml);
  assert.equal(frags.length, 1);
  assert.equal(frags[0].text, yaml); // whole file, not split per value
  assert.equal(frags[0].artifactType, "prompt_template");
});

test(".prompt file → whole-file standalone fragment", () => {
  const content = "You are a translator. Translate EN→FR.";
  const frags = scan("prompts/translate.prompt", content);
  assert.equal(frags.length, 1);
  assert.equal(frags[0].text, content);
  assert.equal(frags[0].artifactType, "prompt_template");
});

test("*.agent.md → standalone; generic .md under prompts/ → not", () => {
  assert.equal(prefilter(".github/agents/my-agent.agent.md", "You are an agent.").standalone, true);
  assert.equal(prefilter("docs/prompts/intro.md", "# Intro\nSome notes.").standalone, false);
});
