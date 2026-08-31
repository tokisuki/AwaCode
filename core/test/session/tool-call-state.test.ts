import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore, type ToolCallStatus } from "../../src/persistence/session-store.ts";
import { transitionToolCall } from "../../src/session/tool-call-state.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";
import {
  disposeChildChannels,
  spawnChildChannel,
  waitForChildExit,
} from "../support/child-process.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-tool-state-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(id: string, rootPath: string): ProjectIdentity {
  return {
    id,
    kind: "remote",
    value: "github.com/openai/awacode",
    remote: "github.com/openai/awacode",
    rootPath,
  };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name)));
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("the persisted tool-call state graph accepts every legal edge and rejects illegal edges", async () => {
  const root = await dataRoot("graph");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  let now = "2026-09-01T01:00:00.000Z";
  const ids = ["session-graph", ...Array.from({ length: 12 }, (_value, index) => `message-${index}`)];
  const store = new SessionStore(connection.db, {
    now: () => new Date(now),
    randomUUID: () => ids.shift() as string,
  });

  const createCall = (callId: string, status: ToolCallStatus = "pending") => {
    store.insertAssistantMessageWithToolCalls({
      sessionId: "session-graph",
      payload: { callId },
      toolCalls: [{ callId, ordinal: 0, toolName: "read", inputText: "{}" }],
    });
    if (status === "running" || status === "success") {
      assert.equal(transitionToolCall(store, {
        callId, expectedStatus: "pending", status: "running",
      }).kind, "applied");
    }
    if (status === "success") {
      assert.equal(transitionToolCall(store, {
        callId, expectedStatus: "running", status, result: { seeded: status },
      }).kind, "applied");
    } else if (status === "failure" || status === "interrupted") {
      assert.equal(transitionToolCall(store, {
        callId, expectedStatus: "pending", status, result: { seeded: status },
      }).kind, "applied");
    } else if (status === "denied") {
      assert.equal(transitionToolCall(store, {
        callId, expectedStatus: "pending", status: "awaiting_approval",
      }).kind, "applied");
      assert.equal(transitionToolCall(store, {
        callId, expectedStatus: "awaiting_approval", status, result: { seeded: status },
      }).kind, "applied");
    }
  };

  try {
    store.upsertProject(identity("project-graph", "D:\\repo"));
    store.createSession("project-graph", "Transition graph");
    const legalPaths: ReadonlyArray<readonly ToolCallStatus[]> = [
      ["pending", "running", "success"],
      ["pending", "awaiting_approval", "running", "failure"],
      ["pending", "awaiting_approval", "denied"],
      ["pending", "failure"],
      ["pending", "interrupted"],
      ["pending", "awaiting_approval", "interrupted"],
      ["pending", "running", "interrupted"],
    ];

    for (const [index, path] of legalPaths.entries()) {
      const callId = `legal-${index}`;
      createCall(callId);
      for (let step = 1; step < path.length; step += 1) {
        const from = path[step - 1] as ToolCallStatus;
        const status = path[step] as ToolCallStatus;
        now = `2026-09-01T01:${String(index).padStart(2, "0")}:${String(step).padStart(2, "0")}.000Z`;
        const outcome = transitionToolCall(store, {
          callId,
          expectedStatus: from,
          status,
          ...(status === "success" || status === "failure" || status === "denied" || status === "interrupted"
            ? { result: { terminal: status } }
            : {}),
        });
        assert.equal(outcome.kind, "applied", `${from} -> ${status}`);
        assert.equal(outcome.call.status, status);
      }
    }

    createCall("illegal-running-denied", "running");
    const runningDenied = transitionToolCall(store, {
      callId: "illegal-running-denied",
      expectedStatus: "running",
      status: "denied",
      result: { terminal: "denied" },
    });
    assert.equal(runningDenied.kind, "conflict");
    assert.equal(runningDenied.reason, "illegal_transition");
    assert.equal(runningDenied.call.status, "running");

    for (const terminal of ["success", "failure", "denied", "interrupted"] as const) {
      const callId = `terminal-${terminal}`;
      createCall(callId, terminal);
      const outcome = transitionToolCall(store, {
        callId,
        expectedStatus: terminal,
        status: "running",
      });
      assert.equal(outcome.kind, "conflict");
      assert.equal(outcome.reason, "illegal_transition");
      assert.equal(outcome.call.status, terminal);
    }
  } finally {
    connection.close();
  }
});

test("terminal transitions require one result and never overwrite terminal data or timestamps", async () => {
  const root = await dataRoot("terminal");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  let now = "2026-09-01T05:00:00.000Z";
  const ids = ["session-terminal", "message-terminal"];
  const store = new SessionStore(connection.db, {
    now: () => new Date(now),
    randomUUID: () => ids.shift() as string,
  });
  try {
    store.upsertProject(identity("project-terminal", "D:\\repo"));
    const session = store.createSession("project-terminal", "Terminal invariants");
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: {},
      toolCalls: [{ callId: "call-terminal", ordinal: 0, toolName: "shell", inputText: "{}" }],
    });

    assert.throws(() => transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "pending",
      status: "failure",
    }), /requires a non-null JSON result/);
    assert.equal(store.loadToolCall("call-terminal").status, "pending");

    now = "2026-09-01T05:01:00.000Z";
    assert.equal(transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "pending",
      status: "running",
    }).kind, "applied");
    now = "2026-09-01T05:02:00.000Z";
    assert.equal(transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "running",
      status: "success",
      result: { content: "original" },
      errorText: "  safe\u0000 error  ",
    }).kind, "applied");
    const terminal = store.loadToolCall("call-terminal");
    assert.deepEqual({
      status: terminal.status,
      result: terminal.result,
      errorText: terminal.errorText,
      startedAt: terminal.startedAt,
      finishedAt: terminal.finishedAt,
    }, {
      status: "success",
      result: { content: "original" },
      errorText: "safe error",
      startedAt: "2026-09-01T05:01:00.000Z",
      finishedAt: "2026-09-01T05:02:00.000Z",
    });

    now = "2026-09-01T05:03:00.000Z";
    const repeated = transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "running",
      status: "success",
      result: { content: "replacement" },
      errorText: "replacement error",
    });
    assert.equal(repeated.kind, "idempotent");
    assert.deepEqual(repeated.call, terminal);
  } finally {
    connection.close();
  }
});

test("the lowest transition boundary rejects terminal results that do not round-trip as strict JSON", async (t) => {
  const root = await dataRoot("strict-terminal-json");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const maximumArrayIndexKey: unknown[] = [];
  Object.defineProperty(maximumArrayIndexKey, "4294967295", {
    value: "dropped",
    enumerable: true,
  });
  const unsafeIntegerArrayKey: unknown[] = [];
  Object.defineProperty(unsafeIntegerArrayKey, "9007199254740992", {
    value: "dropped",
    enumerable: true,
  });
  const sparseArray = new Array<unknown>(2);
  sparseArray[1] = "present";
  const namedPropertyArray: unknown[] = [];
  Object.assign(namedPropertyArray, { diagnostic: "dropped" });
  const nonEnumerablePropertyArray: unknown[] = [];
  Object.defineProperty(nonEnumerablePropertyArray, "diagnostic", {
    value: "hidden",
    enumerable: false,
  });
  const nonEnumerableElementArray: unknown[] = ["hidden"];
  Object.defineProperty(nonEnumerableElementArray, "0", {
    enumerable: false,
  });
  const nestedNonEnumerableElementArray: unknown[] = ["nested hidden"];
  Object.defineProperty(nestedNonEnumerableElementArray, "0", {
    enumerable: false,
  });
  const nestedAugmentedArray: unknown[] = [];
  Object.defineProperty(nestedAugmentedArray, "4294967295", {
    value: "nested dropped",
    enumerable: true,
  });
  const invalidResults: Array<{ name: string; value: unknown }> = [
    { name: "top-level null", value: null },
    { name: "top-level non-finite number", value: Number.NaN },
    { name: "nested non-finite number", value: { nested: Number.POSITIVE_INFINITY } },
    { name: "nested undefined", value: { nested: undefined } },
    { name: "function", value: () => undefined },
    { name: "symbol", value: Symbol("not-json") },
    { name: "JSON-normalizing object", value: new Date("2026-09-01T00:00:00.000Z") },
    { name: "maximum array-index-like own key", value: maximumArrayIndexKey },
    { name: "unsafe-integer array-index-like own key", value: unsafeIntegerArrayKey },
    { name: "sparse array", value: sparseArray },
    { name: "extra named array property", value: namedPropertyArray },
    { name: "non-enumerable named array property", value: nonEnumerablePropertyArray },
    { name: "non-enumerable array element", value: nonEnumerableElementArray },
    { name: "nested non-enumerable array element", value: { nested: nestedNonEnumerableElementArray } },
    { name: "nested augmented array", value: { nested: nestedAugmentedArray } },
  ];
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  invalidResults.push({ name: "cycle", value: cyclic });
  const ids = ["session-strict-terminal-json", "message-strict-terminal-json"];
  const store = new SessionStore(connection.db, { randomUUID: () => ids.shift() as string });
  try {
    store.upsertProject(identity("project-strict-terminal-json", "D:\\repo"));
    const session = store.createSession("project-strict-terminal-json", "Strict terminal JSON");
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: {},
      toolCalls: invalidResults.map(({ name }, ordinal) => ({
        callId: `strict-${ordinal}`,
        ordinal,
        toolName: "read",
        inputText: JSON.stringify({ name }),
      })).concat({
        callId: "strict-dense-array",
        ordinal: invalidResults.length,
        toolName: "read",
        inputText: "{}",
      }),
    });

    for (const [ordinal, item] of invalidResults.entries()) {
      await t.test(item.name, () => {
        const callId = `strict-${ordinal}`;
        assert.throws(() => store.compareAndSwapToolCall({
          callId,
          expectedStatus: "pending",
          status: "failure",
          result: item.value,
        }), TypeError);
        const persisted = store.loadToolCall(callId);
        assert.equal(persisted.status, "pending");
        assert.equal(persisted.result, null);
        assert.equal(persisted.finishedAt, null);
      });
    }

    const denseArray = [0, null, true, "text", { nested: [1, 2] }];
    const dense = store.compareAndSwapToolCall({
      callId: "strict-dense-array",
      expectedStatus: "pending",
      status: "failure",
      result: denseArray,
    });
    assert.equal(dense.applied, true);
    assert.deepEqual(dense.call.result, denseArray);
  } finally {
    connection.close();
  }
});

test("the lowest transition boundary redacts only credential values and preserves diagnostic context", async (t) => {
  const root = await dataRoot("terminal-error-redaction");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-terminal-error-redaction", "message-terminal-error-redaction"];
  const store = new SessionStore(connection.db, { randomUUID: () => ids.shift() as string });
  const cases = [
    {
      input: "API key: api-live-value; upstream timeout",
      expected: "API key: [REDACTED]; upstream timeout",
      secret: "api-live-value",
    },
    {
      input: "OpenAI API key: spaced-vendor-live-value; upstream timeout",
      expected: "OpenAI API key: [REDACTED]; upstream timeout",
      secret: "spaced-vendor-live-value",
    },
    {
      input: "openAiApiKey=vendor-live-value; upstream timeout",
      expected: "openAiApiKey=[REDACTED]; upstream timeout",
      secret: "vendor-live-value",
    },
    {
      input: "ordinary prefix; Authorization: Bearer auth-live-value; upstream timeout",
      expected: "ordinary prefix; Authorization: Bearer [REDACTED]; upstream timeout",
      secret: "auth-live-value",
    },
    {
      input: "openai-api-key=hyphen-live-value; retry failed",
      expected: "openai-api-key=[REDACTED]; retry failed",
      secret: "hyphen-live-value",
    },
    {
      input: "  OPENAI_API_KEY=underscore-live-value; retry failed\u0000  ",
      expected: "OPENAI_API_KEY=[REDACTED]; retry failed",
      secret: "underscore-live-value",
    },
    {
      input: "access_token=token-live-value; retry failed",
      expected: "access_token=[REDACTED]; retry failed",
      secret: "token-live-value",
    },
    {
      input: "client-secret='secret-live-value'; retry failed",
      expected: "client-secret=[REDACTED]; retry failed",
      secret: "secret-live-value",
    },
    {
      input: "refreshToken=refresh-live-value; retry failed",
      expected: "refreshToken=[REDACTED]; retry failed",
      secret: "refresh-live-value",
    },
    {
      input: '\"Authorization\": \"Bearer json-auth-live-value\", \"message\": \"upstream timeout\"',
      expected: '\"Authorization\": \"Bearer [REDACTED]\", \"message\": \"upstream timeout\"',
      secret: "json-auth-live-value",
    },
    {
      input: '\"apiKey\": \"json-api-live-value\", \"message\": \"upstream timeout\"',
      expected: '\"apiKey\": \"[REDACTED]\", \"message\": \"upstream timeout\"',
      secret: "json-api-live-value",
    },
  ] as const;
  const ordinaryDiagnostics = [
    "cancellationToken=aborted; upstream timeout",
    "designToken=primary",
    "tokenCount=42",
    "paginationToken=cursor-42; fetch failed",
    "syntaxSecret=keyword; parser failed",
    "passwordPolicy=strict",
    "cancellation token=aborted",
    "design token=primary",
    "pagination token=cursor-42",
    "syntax secret=keyword",
    "retry failed (cancellation token=aborted); metadata { design token=primary }",
    "fetch failed [pagination token=cursor-42]; parser context (syntax secret=keyword)",
  ] as const;
  try {
    store.upsertProject(identity("project-terminal-error-redaction", "D:\\repo"));
    const session = store.createSession("project-terminal-error-redaction", "Terminal error redaction");
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: {},
      toolCalls: [
        ...cases.map((_item, ordinal) => ({
          callId: `redacted-call-${ordinal}`,
          ordinal,
          toolName: "shell",
          inputText: "{}",
        })),
        ...ordinaryDiagnostics.map((_item, index) => ({
          callId: `ordinary-diagnostic-${index}`,
          ordinal: cases.length + index,
          toolName: "shell",
          inputText: "{}",
        })),
      ],
    });

    for (const [ordinal, item] of cases.entries()) {
      await t.test(item.input, () => {
        const callId = `redacted-call-${ordinal}`;
        const outcome = store.compareAndSwapToolCall({
          callId,
          expectedStatus: "pending",
          status: "failure",
          result: { message: "command failed" },
          errorText: item.input,
        });
        assert.equal(outcome.applied, true);
        assert.equal(outcome.call.errorText, item.expected);
        const raw = connection.db.prepare("SELECT error_text FROM tool_calls WHERE call_id = ?")
          .get(callId) as { error_text: string };
        assert.equal(raw.error_text, item.expected);
        assert.equal(raw.error_text.includes(item.secret), false);
      });
    }

    for (const [index, diagnostic] of ordinaryDiagnostics.entries()) {
      await t.test(`does not redact ${diagnostic}`, () => {
        const callId = `ordinary-diagnostic-${index}`;
        const outcome = store.compareAndSwapToolCall({
          callId,
          expectedStatus: "pending",
          status: "failure",
          result: { message: "command failed" },
          errorText: diagnostic,
        });
        assert.equal(outcome.applied, true);
        assert.equal(outcome.call.errorText, diagnostic);
        const raw = connection.db.prepare("SELECT error_text FROM tool_calls WHERE call_id = ?")
          .get(callId) as { error_text: string };
        assert.equal(raw.error_text, diagnostic);
      });
    }
  } finally {
    connection.close();
  }
});

test("two real processes race allow against deny or cancel and only the CAS winner begins its action", async (t) => {
  for (const terminalTarget of ["denied", "interrupted"] as const) {
    await t.test(`allow versus ${terminalTarget}`, async () => {
      const root = await dataRoot(`process-race-${terminalTarget}`);
      const callId = `process-race-${terminalTarget}`;
      const setupConnection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
      const ids = [`session-${terminalTarget}`, `message-${terminalTarget}`];
      const setup = new SessionStore(setupConnection.db, { randomUUID: () => ids.shift() as string });
      try {
        setup.upsertProject(identity(`project-${terminalTarget}`, "D:\\repo"));
        const session = setup.createSession(`project-${terminalTarget}`, "Process approval race");
        setup.insertAssistantMessageWithToolCalls({
          sessionId: session.id,
          payload: {},
          toolCalls: [{ callId, ordinal: 0, toolName: "write", inputText: "{}" }],
        });
        assert.equal(transitionToolCall(setup, {
          callId,
          expectedStatus: "pending",
          status: "awaiting_approval",
        }).kind, "applied");
      } finally {
        setupConnection.close();
      }

      const claims = join(root, "claims");
      await mkdir(claims);
      const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "tool-call-transition-child.ts");
      const channels = ["running", terminalTarget].map((target) =>
        spawnChildChannel(process.execPath, [fixture, root, callId, target, claims], {
          env: cleanEnvironment(),
        }));
      try {
        assert.deepEqual(await Promise.all(channels.map(({ lines }) => lines.nextLine())), ["READY", "READY"]);
        const results = channels.map(({ lines }) => lines.nextLine());
        for (const channel of channels) {
          channel.child.stdin.end("GO\n");
        }
        const outcomes = (await Promise.all(results)).map((line) => JSON.parse(line) as {
          target: "running" | "denied" | "interrupted";
          kind: "applied" | "idempotent" | "conflict";
          observedStatus: ToolCallStatus;
        });
        assert.equal(outcomes.filter(({ kind }) => kind === "applied").length, 1);
        assert.equal(outcomes.filter(({ kind }) => kind === "conflict").length, 1);
        assert.deepEqual(
          (await Promise.all(channels.map((channel, index) =>
            waitForChildExit(channel, 5000, `transition racer ${index} completion`)))).map(([code]) => code),
          [0, 0],
        );

        const claimFiles = await readdir(claims);
        assert.equal(claimFiles.length, 1);
        const appliedTarget = outcomes.find(({ kind }) => kind === "applied")?.target;
        assert.equal(await readFile(join(claims, claimFiles[0] as string), "utf8"), appliedTarget);
        assert.equal(claimFiles[0], `${appliedTarget}.claim`);

        const verifiedConnection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
        try {
          assert.equal(new SessionStore(verifiedConnection.db).loadToolCall(callId).status, appliedTarget);
        } finally {
          verifiedConnection.close();
        }
      } finally {
        await disposeChildChannels(channels, `transition ${terminalTarget} racers cleanup`);
      }
    });
  }
});

test("the lowest public transition boundary rejects graph bypasses and preserves terminal data", async () => {
  const root = await dataRoot("boundary");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-boundary", "message-boundary"];
  const store = new SessionStore(connection.db, { randomUUID: () => ids.shift() as string });
  try {
    store.upsertProject(identity("project-boundary", "D:\\repo"));
    const session = store.createSession("project-boundary", "Boundary invariants");
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: {},
      toolCalls: [
        { callId: "terminal-boundary", ordinal: 0, toolName: "read", inputText: "{}" },
        { callId: "pending-boundary", ordinal: 1, toolName: "write", inputText: "{}" },
      ],
    });
    assert.equal(transitionToolCall(store, {
      callId: "terminal-boundary",
      expectedStatus: "pending",
      status: "running",
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "terminal-boundary",
      expectedStatus: "running",
      status: "success",
      result: { content: "original" },
    }).kind, "applied");
    const terminalBefore = store.loadToolCall("terminal-boundary");

    const overwrite = store.compareAndSwapToolCall({
      callId: "terminal-boundary",
      expectedStatus: "success",
      status: "failure",
      result: { content: "replacement" },
    });
    assert.equal(overwrite.applied, false);
    assert.deepEqual(overwrite.call, terminalBefore);

    const shortcut = store.compareAndSwapToolCall({
      callId: "pending-boundary",
      expectedStatus: "pending",
      status: "denied",
      result: { reason: "invalid shortcut" },
    });
    assert.equal(shortcut.applied, false);
    assert.equal(shortcut.call.status, "pending");
    assert.equal(shortcut.call.result, null);
  } finally {
    connection.close();
  }
});
