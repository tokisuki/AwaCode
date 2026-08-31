import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ProjectIdentity, ProjectIdentityKind } from "../project/project-identity.ts";
import {
  isLegalToolCallTransition,
  isTerminalToolCallStatus,
} from "../session/tool-call-transition-policy.ts";

export type SessionStatus = "idle" | "running" | "completed" | "interrupted" | "cancelled" | "error";
export type MessageRole = "system" | "user" | "assistant" | "tool" | "internal";
export type MessageStatus = "streaming" | "complete" | "interrupted";
export type ToolCallStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "success"
  | "failure"
  | "denied"
  | "interrupted";

export interface ProjectRecord {
  id: string;
  identityKind: ProjectIdentityKind;
  identityValue: string;
  remote: string | null;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  model: unknown | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: MessageRole;
  kind: string;
  payload: unknown;
  status: MessageStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallRecord {
  callId: string;
  sessionId: string;
  assistantMessageId: string;
  ordinal: number;
  toolName: string;
  inputText: string;
  status: ToolCallStatus;
  result: unknown | null;
  errorText: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LoadedSession {
  session: SessionRecord;
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}

export interface InsertMessageInput {
  sessionId: string;
  role: MessageRole;
  kind: string;
  payload: unknown;
  status?: MessageStatus;
}

export interface PendingToolCallInput {
  callId: string;
  ordinal: number;
  toolName: string;
  inputText: string;
}

export interface InsertAssistantMessageWithToolCallsInput {
  sessionId: string;
  payload: unknown;
  toolCalls: readonly PendingToolCallInput[];
}

export interface InsertedAssistantToolCallBlock {
  message: MessageRecord;
  toolCalls: ToolCallRecord[];
}

export interface CompareAndSwapToolCallInput {
  callId: string;
  expectedStatus: ToolCallStatus;
  status: ToolCallStatus;
  result?: unknown;
  errorText?: string;
}

export interface CompareAndSwapToolCallResult {
  applied: boolean;
  call: ToolCallRecord;
}

export interface InterruptedStateResults {
  notStarted: unknown;
  outcomeUnknown: unknown;
  notStartedErrorText: string;
  outcomeUnknownErrorText: string;
}

export interface RecoverySummary {
  interruptedCount: number;
  sessionsInterrupted: number;
  messagesInterrupted: number;
  notStartedCallsInterrupted: number;
  outcomeUnknownCallsInterrupted: number;
}

export interface SessionStoreOptions {
  now?: () => Date;
  randomUUID?: () => string;
}

export class StoreNotFoundError extends Error {
  readonly entity: "project" | "session" | "tool_call";
  readonly id: string;

  constructor(entity: "project" | "session" | "tool_call", id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "StoreNotFoundError";
    this.entity = entity;
    this.id = id;
  }
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("value must be JSON serializable");
  }
  return json;
}

function projectRecord(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    identityKind: String(row.identity_kind) as ProjectIdentityKind,
    identityValue: String(row.identity_value),
    remote: row.remote === null ? null : String(row.remote),
    rootPath: String(row.root_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function sessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    model: parseJson(row.model_json === null ? null : String(row.model_json)),
    status: String(row.status) as SessionStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function messageRecord(row: Record<string, unknown>): MessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    seq: Number(row.seq),
    role: String(row.role) as MessageRole,
    kind: String(row.kind),
    payload: parseJson(String(row.payload_json)),
    status: String(row.status) as MessageStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toolCallRecord(row: Record<string, unknown>): ToolCallRecord {
  return {
    callId: String(row.call_id),
    sessionId: String(row.session_id),
    assistantMessageId: String(row.assistant_message_id),
    ordinal: Number(row.ordinal),
    toolName: String(row.tool_name),
    inputText: String(row.input_text),
    status: String(row.status) as ToolCallStatus,
    result: parseJson(row.result_json === null ? null : String(row.result_json)),
    errorText: row.error_text === null ? null : String(row.error_text),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly currentDate: () => Date;
  private readonly createId: () => string;

  constructor(db: DatabaseSync, options: SessionStoreOptions = {}) {
    this.db = db;
    this.currentDate = options.now ?? (() => new Date());
    this.createId = options.randomUUID ?? randomUUID;
  }

  upsertProject(identity: ProjectIdentity): ProjectRecord {
    const now = this.currentDate().toISOString();
    this.db.prepare(`
      INSERT INTO projects
        (id, identity_kind, identity_value, remote, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        identity_kind = excluded.identity_kind,
        identity_value = excluded.identity_value,
        remote = excluded.remote,
        root_path = excluded.root_path,
        updated_at = excluded.updated_at
    `).run(
      identity.id,
      identity.kind,
      identity.value,
      identity.remote ?? null,
      identity.rootPath,
      now,
      now,
    );
    return this.getProject(identity.id);
  }

  createSession(projectId: string, title = "New session"): SessionRecord {
    this.requireProject(projectId);
    const id = this.createId();
    const now = this.currentDate().toISOString();
    this.db.prepare(`
      INSERT INTO sessions
        (id, project_id, title, model_json, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', ?, ?)
    `).run(id, projectId, title, now, now);
    return this.getSession(id);
  }

  listSessions(projectId: string): SessionRecord[] {
    this.requireProject(projectId);
    return (this.db.prepare(`
      SELECT id, project_id, title, model_json, status, created_at, updated_at
      FROM sessions
      WHERE project_id = ?
      ORDER BY updated_at DESC, id DESC
    `).all(projectId) as unknown as Record<string, unknown>[]).map(sessionRecord);
  }

  loadSession(sessionId: string): LoadedSession {
    const session = this.getSession(sessionId);
    const messages = (this.db.prepare(`
      SELECT id, session_id, seq, role, kind, payload_json, status, created_at, updated_at
      FROM messages
      WHERE session_id = ?
      ORDER BY seq
    `).all(sessionId) as unknown as Record<string, unknown>[]).map(messageRecord);
    const toolCalls = (this.db.prepare(`
      SELECT
        tool_calls.call_id,
        tool_calls.session_id,
        tool_calls.assistant_message_id,
        tool_calls.ordinal,
        tool_calls.tool_name,
        tool_calls.input_text,
        tool_calls.status,
        tool_calls.result_json,
        tool_calls.error_text,
        tool_calls.created_at,
        tool_calls.started_at,
        tool_calls.finished_at
      FROM tool_calls
      JOIN messages ON messages.id = tool_calls.assistant_message_id
      WHERE tool_calls.session_id = ?
      ORDER BY messages.seq, tool_calls.ordinal
    `).all(sessionId) as unknown as Record<string, unknown>[]).map(toolCallRecord);
    return { session, messages, toolCalls };
  }

  insertMessage(input: InsertMessageInput): MessageRecord {
    if (input.role === "tool" || (input.role === "assistant" && input.kind === "tool_calls")) {
      throw new TypeError("tool protocol messages require the atomic assistant tool-call block API");
    }
    const id = this.createId();
    const now = this.currentDate().toISOString();
    const payloadJson = stringifyJson(input.payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireSession(input.sessionId);
      const next = this.db.prepare(`
        SELECT COALESCE(MAX(seq), 0) + 1 AS seq
        FROM messages
        WHERE session_id = ?
      `).get(input.sessionId) as { seq: number };
      this.db.prepare(`
        INSERT INTO messages
          (id, session_id, seq, role, kind, payload_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.sessionId,
        next.seq,
        input.role,
        input.kind,
        payloadJson,
        input.status ?? "complete",
        now,
        now,
      );
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
      this.db.exec("COMMIT");
      return this.getMessage(id);
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  insertAssistantMessageWithToolCalls(
    input: InsertAssistantMessageWithToolCallsInput,
  ): InsertedAssistantToolCallBlock {
    if (input.toolCalls.length === 0) {
      throw new TypeError("an atomic assistant tool-call block requires at least one tool call");
    }
    const id = this.createId();
    const now = this.currentDate().toISOString();
    const payloadJson = stringifyJson(input.payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireSession(input.sessionId);
      const next = this.db.prepare(`
        SELECT COALESCE(MAX(seq), 0) + 1 AS seq
        FROM messages
        WHERE session_id = ?
      `).get(input.sessionId) as { seq: number };
      this.db.prepare(`
        INSERT INTO messages
          (id, session_id, seq, role, kind, payload_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'assistant', 'tool_calls', ?, 'complete', ?, ?)
      `).run(id, input.sessionId, next.seq, payloadJson, now, now);

      const insertCall = this.db.prepare(`
        INSERT INTO tool_calls
          (call_id, session_id, assistant_message_id, ordinal, tool_name, input_text, status,
           result_json, error_text, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)
      `);
      for (const [index, toolCall] of input.toolCalls.entries()) {
        if (!Number.isSafeInteger(toolCall.ordinal) || toolCall.ordinal !== index) {
          throw new RangeError("tool-call ordinals must be unique and zero-based in array order");
        }
        insertCall.run(
          toolCall.callId,
          input.sessionId,
          id,
          toolCall.ordinal,
          toolCall.toolName,
          toolCall.inputText,
          now,
        );
      }
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
      this.db.exec("COMMIT");
      return {
        message: this.getMessage(id),
        toolCalls: input.toolCalls.map(({ callId }) => this.getToolCall(callId)),
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  loadToolCall(callId: string): ToolCallRecord {
    return this.getToolCall(callId);
  }

  compareAndSwapToolCall(input: CompareAndSwapToolCallInput): CompareAndSwapToolCallResult {
    if (!isLegalToolCallTransition(input.expectedStatus, input.status)) {
      return { applied: false, call: this.getToolCall(input.callId) };
    }
    const terminal = isTerminalToolCallStatus(input.status);
    if (terminal && (input.result === undefined || input.result === null)) {
      throw new TypeError("terminal tool-call transition requires a non-null JSON result");
    }
    if (!terminal && input.result !== undefined) {
      throw new TypeError("nonterminal tool-call transition cannot have a result");
    }
    const now = this.currentDate().toISOString();
    const assignments = ["status = ?"];
    const values: Array<string | null> = [input.status];
    if (input.status === "running") {
      assignments.push("started_at = COALESCE(started_at, ?)");
      values.push(now);
    }
    if (terminal) {
      assignments.push("result_json = ?", "error_text = ?", "finished_at = ?");
      values.push(stringifyJson(input.result), input.errorText ?? null, now);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(`
        UPDATE tool_calls
        SET ${assignments.join(", ")}
        WHERE call_id = ? AND status = ?
      `).run(...values, input.callId, input.expectedStatus);
      const call = this.getToolCall(input.callId);
      this.db.exec("COMMIT");
      return { applied: update.changes === 1, call };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  convergeInterruptedState(results: InterruptedStateResults): RecoverySummary {
    const now = this.currentDate().toISOString();
    const notStartedJson = stringifyJson(results.notStarted);
    const outcomeUnknownJson = stringifyJson(results.outcomeUnknown);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sessionsInterrupted = Number(this.db.prepare(`
        UPDATE sessions
        SET status = 'interrupted', updated_at = ?
        WHERE status = 'running'
      `).run(now).changes);
      const messagesInterrupted = Number(this.db.prepare(`
        UPDATE messages
        SET status = 'interrupted', updated_at = ?
        WHERE role = 'assistant' AND status = 'streaming'
      `).run(now).changes);
      const notStartedCallsInterrupted = Number(this.db.prepare(`
        UPDATE tool_calls
        SET status = 'interrupted', result_json = ?, error_text = ?, finished_at = ?
        WHERE status IN ('pending', 'awaiting_approval')
      `).run(notStartedJson, results.notStartedErrorText, now).changes);
      const outcomeUnknownCallsInterrupted = Number(this.db.prepare(`
        UPDATE tool_calls
        SET status = 'interrupted', result_json = ?, error_text = ?, finished_at = ?
        WHERE status = 'running'
      `).run(outcomeUnknownJson, results.outcomeUnknownErrorText, now).changes);
      this.db.exec("COMMIT");
      return {
        interruptedCount: notStartedCallsInterrupted + outcomeUnknownCallsInterrupted,
        sessionsInterrupted,
        messagesInterrupted,
        notStartedCallsInterrupted,
        outcomeUnknownCallsInterrupted,
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private requireProject(id: string): void {
    if (this.db.prepare("SELECT id FROM projects WHERE id = ?").get(id) === undefined) {
      throw new StoreNotFoundError("project", id);
    }
  }

  private requireSession(id: string): void {
    if (this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id) === undefined) {
      throw new StoreNotFoundError("session", id);
    }
  }

  private getProject(id: string): ProjectRecord {
    const row = this.db.prepare(`
      SELECT id, identity_kind, identity_value, remote, root_path, created_at, updated_at
      FROM projects WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new StoreNotFoundError("project", id);
    }
    return projectRecord(row);
  }

  private getSession(id: string): SessionRecord {
    const row = this.db.prepare(`
      SELECT id, project_id, title, model_json, status, created_at, updated_at
      FROM sessions WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new StoreNotFoundError("session", id);
    }
    return sessionRecord(row);
  }

  private getMessage(id: string): MessageRecord {
    const row = this.db.prepare(`
      SELECT id, session_id, seq, role, kind, payload_json, status, created_at, updated_at
      FROM messages WHERE id = ?
    `).get(id) as Record<string, unknown>;
    return messageRecord(row);
  }

  private getToolCall(callId: string): ToolCallRecord {
    const row = this.db.prepare(`
      SELECT call_id, session_id, assistant_message_id, ordinal, tool_name, input_text, status,
             result_json, error_text, created_at, started_at, finished_at
      FROM tool_calls WHERE call_id = ?
    `).get(callId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new StoreNotFoundError("tool_call", callId);
    }
    return toolCallRecord(row);
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // Preserve the operation failure when SQLite already ended the transaction.
    }
  }
}
