import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";

import type { EffectiveModelConfig } from "../../src/config/model-config.ts";
import {
  ModelRequestError,
  OpenAIChatClient,
  OpenAIModelConnectionTester,
} from "../../src/llm/openai-chat-client.ts";
import { ModelContextOverflowError } from "../../src/llm/types.ts";

interface CapturedRequest {
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface ScriptedServer {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

async function scriptedServer(
  respond: (request: IncomingMessage, response: ServerResponse, body: unknown) => void | Promise<void>,
): Promise<ScriptedServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown;
    requests.push({
      url: request.url,
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      body,
    });
    await respond(request, response, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server has no TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function stream(response: ServerResponse, chunks: readonly Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function config(baseUrl: string, model = "fixture-model"): EffectiveModelConfig {
  return {
    runnable: true,
    baseUrl,
    model,
    contextLimit: 32768,
    maxOutputTokens: 4096,
    apiKey: "fixture-openai-key",
    sources: {
      baseUrl: "file",
      model: "file",
      contextLimit: "file",
      maxOutputTokens: "file",
      apiKey: "file",
    },
    issues: [],
  };
}

test("captures DeepSeek reasoning_content and replays it on tool-bearing requests", async () => {
  let requestIndex = 0;
  const server = await scriptedServer((_request, response) => {
    requestIndex += 1;
    stream(response, requestIndex === 1
      ? [
        { choices: [{ index: 0, delta: { reasoning_content: "inspect " } }] },
        { choices: [{ index: 0, delta: { reasoning_content: "carefully", content: "Plan." }, finish_reason: "stop" }] },
      ]
      : [{ choices: [{ index: 0, delta: { content: "Executing." }, finish_reason: "stop" }] }]);
  });
  try {
    const client = new OpenAIChatClient(config(server.baseUrl, "deepseek-v4-flash"));
    const plan = await client.stream({ messages: [{ role: "user", content: "Inspect the project" }] });
    assert.equal(plan.reasoningContent, "inspect carefully");

    await client.stream({
      messages: [
        { role: "user", content: "Inspect the project" },
        { role: "assistant", content: plan.content, reasoningContent: plan.reasoningContent, toolCalls: [] },
      ],
      tools: [{ type: "function", function: { name: "list_files", parameters: { type: "object" } } }],
    });

    const messages = (server.requests[1]?.body as { messages?: Array<Record<string, unknown>> }).messages;
    assert.deepEqual(messages?.[1], {
      role: "assistant",
      content: "Plan.",
      reasoning_content: "inspect carefully",
    });
  } finally {
    await server.close();
  }
});

test("fills missing DeepSeek reasoning history but leaves other providers unchanged", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
  });
  const messages = [
    { role: "user" as const, content: "Continue" },
    { role: "assistant" as const, content: "Legacy answer", toolCalls: [] },
  ];
  const tools = [{ type: "function" as const, function: { name: "list_files", parameters: { type: "object" } } }];
  try {
    await new OpenAIChatClient(config(server.baseUrl, "deepseek-v4-flash")).stream({ messages, tools });
    await new OpenAIChatClient(config(server.baseUrl, "fixture-model")).stream({ messages, tools });

    const deepSeekMessages = (server.requests[0]?.body as { messages: Array<Record<string, unknown>> }).messages;
    const genericMessages = (server.requests[1]?.body as { messages: Array<Record<string, unknown>> }).messages;
    assert.equal(deepSeekMessages[1]?.reasoning_content, "");
    assert.equal(Object.hasOwn(genericMessages[1]!, "reasoning_content"), false);
  } finally {
    await server.close();
  }
});

test("streams text deltas and returns their complete assistant content", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "你好" } }] },
      { choices: [{ index: 0, delta: { content: "，世界" }, finish_reason: "stop" }] },
    ]);
  });
  try {
    const deltas: string[] = [];
    const result = await new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Say hello" }],
      onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    assert.deepEqual(deltas, ["你好", "，世界"]);
    assert.deepEqual(result, {
      role: "assistant",
      content: "你好，世界",
      toolCalls: [],
      finishReason: "stop",
    });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.url, "/v1/chat/completions");
    assert.equal(server.requests[0]?.authorization, "Bearer fixture-openai-key");
  } finally {
    await server.close();
  }
});

test("honors a narrower per-request output cap for context summarization", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [{ choices: [{ index: 0, delta: { content: "short" }, finish_reason: "stop" }] }]);
  });
  try {
    await new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Summarize" }],
      maxOutputTokens: 123,
    });
    assert.equal((server.requests[0]?.body as { max_tokens?: unknown }).max_tokens, 123);
  } finally {
    await server.close();
  }
});

test("serializes system, assistant-tool, and tool-result history for a continuation", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [{ choices: [{ index: 0, delta: { content: "continued" }, finish_reason: "stop" }] }]);
  });
  try {
    await new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "Inspect the file." },
        {
          role: "assistant",
          content: "I will inspect it.",
          toolCalls: [{ id: "call_read", name: "read_file", arguments: "{\"path\":\"src/app.ts\"}" }],
        },
        { role: "tool", toolCallId: "call_read", content: "export const value = 1;" },
      ],
    });

    assert.deepEqual((server.requests[0]?.body as { messages?: unknown }).messages, [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Inspect the file." },
      {
        role: "assistant",
        content: "I will inspect it.",
        tool_calls: [{
          id: "call_read",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"src/app.ts\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_read", content: "export const value = 1;" },
    ]);
  } finally {
    await server.close();
  }
});

test("assembles fragmented function tool calls in their stream index order", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, id: "call_", type: "function", function: { name: "sec", arguments: "{\"b\":" } },
              { index: 0, id: "call_", type: "function", function: { name: "fir", arguments: "{\"a\":" } },
            ],
          },
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "first", function: { name: "st", arguments: "1}" } },
              { index: 1, id: "second", function: { name: "ond", arguments: "2}" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      },
    ]);
  });
  try {
    const result = await new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Use both tools" }],
      tools: [
        { type: "function", function: { name: "first", description: "first", parameters: { type: "object" } } },
        { type: "function", function: { name: "second", description: "second", parameters: { type: "object" } } },
      ],
    });

    assert.deepEqual(result, {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_first", name: "first", arguments: "{\"a\":1}" },
        { id: "call_second", name: "second", arguments: "{\"b\":2}" },
      ],
      finishReason: "tool_calls",
    });
  } finally {
    await server.close();
  }
});

test("rejects a completed stream with incomplete function call arguments", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [{
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_broken",
            type: "function",
            function: { name: "broken", arguments: "{" },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }]);
  });
  try {
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Malformed call" }],
    }), (error: unknown) => error instanceof ModelRequestError && error.code === "malformed_stream");
  } finally {
    await server.close();
  }
});

test("rejects a stream that ends without a completion finish reason", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [{ choices: [{ index: 0, delta: { content: "unfinished" } }] }]);
  });
  try {
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Incomplete answer" }],
    }), (error: unknown) => error instanceof ModelRequestError && error.code === "malformed_stream");
  } finally {
    await server.close();
  }
});

test("cancels an in-flight streaming request through its AbortSignal", async () => {
  let entered!: () => void;
  const requestEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = await scriptedServer(async (request, response) => {
    entered();
    await Promise.race([
      once(request, "close"),
      new Promise<void>((resolve) => setTimeout(resolve, 200)),
    ]);
    response.end();
  });
  try {
    const controller = new AbortController();
    const pending = new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Wait" }],
      signal: controller.signal,
    });
    await requestEntered;
    controller.abort();

    const outcome = await Promise.race([
      pending.then(() => "completed", (error: unknown) => error),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 80)),
    ]);
    assert.equal(outcome instanceof ModelRequestError && outcome.code === "cancelled", true);
  } finally {
    await server.close();
  }
});

test("retries a rate-limited request and honors its Retry-After delay", async () => {
  let attempts = 0;
  const server = await scriptedServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    stream(response, [{ choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: "stop" }] }]);
  });
  try {
    const delays: number[] = [];
    const result = await new OpenAIChatClient(config(server.baseUrl), {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }).stream({ messages: [{ role: "user", content: "Retry me" }] });

    assert.equal(result.content, "recovered");
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2000]);
  } finally {
    await server.close();
  }
});

test("stops after three total retryable attempts", async () => {
  let attempts = 0;
  const server = await scriptedServer((_request, response) => {
    attempts += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
  });
  try {
    const delays: number[] = [];
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl), {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }).stream({ messages: [{ role: "user", content: "Bound retry" }] }), ModelRequestError);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [250, 500]);
  } finally {
    await server.close();
  }
});

test("does not retry an authentication failure", async () => {
  let attempts = 0;
  const server = await scriptedServer((_request, response) => {
    attempts += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid credential" } }));
  });
  try {
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Do not retry" }],
    }));
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("does not retry after a partially emitted stream fails", async () => {
  let attempts = 0;
  const server = await scriptedServer((_request, response) => {
    attempts += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`);
    setTimeout(() => response.destroy(new Error("fixture stream break")), 20);
  });
  try {
    const deltas: string[] = [];
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl), {
      sleep: async () => {
        throw new Error("must not sleep after partial output");
      },
    }).stream({
      messages: [{ role: "user", content: "Partial failure" }],
      onTextDelta(delta) {
        deltas.push(delta);
      },
    }));
    assert.deepEqual(deltas, ["partial"]);
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("does not retry after a non-empty reasoning-only stream fragment", async () => {
  let attempts = 0;
  const server = await scriptedServer((_request, response) => {
    attempts += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "private reasoning" } }] })}\n\n`);
    setTimeout(() => response.destroy(new Error("fixture stream break")), 20);
  });
  try {
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl, "deepseek-v4-flash"), {
      sleep: async () => {
        throw new Error("must not sleep after reasoning output");
      },
    }).stream({ messages: [{ role: "user", content: "Reason first" }] }));
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("an empty reasoning marker does not suppress a safe transport retry", async () => {
  let attempts = 0;
  const server = await scriptedServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "" } }] })}\n\n`);
      setTimeout(() => response.destroy(new Error("fixture stream break")), 20);
      return;
    }
    stream(response, [{ choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: "stop" }] }]);
  });
  try {
    const result = await new OpenAIChatClient(config(server.baseUrl, "deepseek-v4-flash"), {
      sleep: async () => undefined,
    }).stream({ messages: [{ role: "user", content: "Retry empty marker" }] });
    assert.equal(result.content, "recovered");
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test("returns a redacted model failure without response headers or credential fragments", async () => {
  const server = await scriptedServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json", authorization: "Bearer fixture-openai-key" });
    response.end(JSON.stringify({
      error: {
        message: "upstream rejected Bearer fixture-openai-key",
        details: { api_key: "fixture-openai-key" },
      },
    }));
  });
  try {
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "Sanitize failure" }],
    }), (error: unknown) => {
      assert.equal(error instanceof ModelRequestError, true);
      if (!(error instanceof ModelRequestError)) {
        return false;
      }
      assert.equal(error.code, "request_failed");
      assert.equal(error.message, "Model request failed");
      const diagnostic = JSON.stringify(error.diagnostic);
      assert.equal(diagnostic.includes("fixture-openai-key"), false);
      assert.equal(diagnostic.toLowerCase().includes("authorization"), false);
      assert.match(diagnostic, /\[REDACTED\]/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("classifies a provider context-length response for ContextManager compression without transport retry", async () => {
  let attempts = 0;
  const server = await scriptedServer((_request, response) => {
    attempts += 1;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }));
  });
  try {
    await assert.rejects(new OpenAIChatClient(config(server.baseUrl)).stream({
      messages: [{ role: "user", content: "oversized" }],
    }), ModelContextOverflowError);
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("connection tester sends one explicit minimal request through the provider", async () => {
  const server = await scriptedServer((_request, response) => {
    stream(response, [{ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] }]);
  });
  try {
    const result = await new OpenAIModelConnectionTester().test(
      config(server.baseUrl),
      new AbortController().signal,
    );

    assert.deepEqual(result, { message: "Model connection succeeded" });
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.requests[0]?.body, {
      model: "fixture-model",
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 1,
      stream: true,
    });
  } finally {
    await server.close();
  }
});
