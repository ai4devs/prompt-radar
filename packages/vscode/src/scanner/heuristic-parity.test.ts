import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilter } from "./prefilter";
import { extractCodeUnits, type CodeScope } from "./extractor";

function units(path: string, content: string, scope: CodeScope = "auto") {
  return extractCodeUnits(path, content, prefilter(path, content), {
    minConfidence: 0.6,
    scope,
    maxChars: 16000,
  });
}

// Invariant every emitted fragment must satisfy: the recorded text is exactly the
// document slice (inline diagnostics depend on this).
function assertVerbatim(content: string, frags: ReturnType<typeof units>) {
  for (const f of frags) {
    assert.equal(content.slice(f.char_start, f.char_end), f.text);
  }
}

// ── Java ─────────────────────────────────────────────────────────────────────

const JAVA_SPRING = `package com.acme.review;

import org.springframework.ai.chat.client.ChatClient;

public class ReviewService {
    private final ChatClient client;

    public String review(String diff) {
        String system = """
            You are a meticulous code reviewer. Be concise and specific.
            """;
        return client.prompt(system).user(diff).call().content();
    }
}
`;

test("Java: Spring AI text-block system prompt is detected", () => {
  assert.equal(prefilter("ReviewService.java", JAVA_SPRING).hasSdkImport, true);
  const u = units("ReviewService.java", JAVA_SPRING, "fragments");
  assert.equal(u.length, 1);
  assert.match(u[0].text, /You are a meticulous code reviewer/);
  assertVerbatim(JAVA_SPRING, u);
});

const JAVA_LC4J = `import dev.langchain4j.service.SystemMessage;

interface Assistant {
    @SystemMessage("You are a helpful assistant that always responds in JSON.")
    String chat(String userMessage);
}
`;

test("Java: LangChain4j @SystemMessage annotation arg is detected", () => {
  assert.equal(prefilter("Assistant.java", JAVA_LC4J).hasSdkImport, true);
  const u = units("Assistant.java", JAVA_LC4J, "fragments");
  assert.equal(u.length, 1);
  assert.match(u[0].text, /always responds in JSON/);
  assertVerbatim(JAVA_LC4J, u);
});

test("Java: non-AI controller with a long string → 0", () => {
  const java = `package com.acme.web;

import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    public String status() {
        return "The service is currently running and healthy at this time.";
    }
}
`;
  assert.equal(prefilter("HealthController.java", java).suspect, false);
  assert.equal(units("HealthController.java", java).length, 0);
});

// ── C# ───────────────────────────────────────────────────────────────────────

const CS_SK_VERBATIM = `using Microsoft.SemanticKernel;

public class Agent
{
    public async Task<string> Run(Kernel kernel, string input)
    {
        string prompt = @"You are a translator.
Translate the user's text to French. Keep the original tone.";
        return await kernel.InvokePromptAsync(prompt);
    }
}
`;

test("C#: Semantic Kernel verbatim prompt is detected", () => {
  assert.equal(prefilter("Agent.cs", CS_SK_VERBATIM).hasSdkImport, true);
  const u = units("Agent.cs", CS_SK_VERBATIM, "fragments");
  assert.equal(u.length, 1);
  assert.match(u[0].text, /You are a translator/);
  assertVerbatim(CS_SK_VERBATIM, u);
});

const CS_INTERPOLATED = `using Microsoft.SemanticKernel.ChatCompletion;

public class Chat
{
    public void Build(ChatHistory history, string topic)
    {
        history.AddSystemMessage($"You are an expert on {topic}. Answer briefly and cite sources.");
    }
}
`;

test("C#: AddSystemMessage interpolated string at the call site is detected", () => {
  const u = units("Chat.cs", CS_INTERPOLATED, "fragments");
  assert.equal(u.length, 1);
  assert.match(u[0].text, /You are an expert on \{topic\}/);
  assertVerbatim(CS_INTERPOLATED, u);
});

const CS_RAW = `using Microsoft.SemanticKernel;

public class Prompts
{
    public string System = """
        You are a strict JSON formatter. Output only valid JSON, no prose.
        """;
}
`;

test("C#: raw string literal prompt-named field is detected", () => {
  const u = units("Prompts.cs", CS_RAW, "fragments");
  assert.equal(u.length, 1);
  assert.match(u[0].text, /strict JSON formatter/);
  assertVerbatim(CS_RAW, u);
});

test("C#: ASP.NET handler with a long string → 0", () => {
  const cs = `using Microsoft.AspNetCore.Mvc;

public class HomeController : Controller
{
    public IActionResult Index()
    {
        var message = "Welcome to our website. Browse the catalog to find products.";
        return Content(message);
    }
}
`;
  assert.equal(prefilter("HomeController.cs", cs).suspect, false);
  assert.equal(units("HomeController.cs", cs).length, 0);
});

test("C#: 'openai' in a string and `using OpenAIWidgets` are NOT SDK imports", () => {
  const cs = `using OpenAIWidgets;

public class Cfg
{
    public string Endpoint = "https://api.example.com/openai/v1/chat/completions";
}
`;
  assert.equal(prefilter("Cfg.cs", cs).hasSdkImport, false);
  assert.equal(units("Cfg.cs", cs).length, 0);
});
