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
