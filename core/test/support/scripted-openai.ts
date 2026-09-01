import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface CapturedOpenAIRequest {
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export type SseTurn = readonly Record<string, unknown>[];

export interface ScriptedOpenAIServer {
  readonly baseUrl: string;
  readonly requests: CapturedOpenAIRequest[];
  close(): Promise<void>;
}

export function textTurn(content: string): SseTurn {
  return [{ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] }];
}

export function toolTurn(id: string, name: string, input: Record<string, unknown>): SseTurn {
  return [{
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }];
}

function writeTurn(response: ServerResponse, chunks: SseTurn): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function startScriptedOpenAI(turns: readonly SseTurn[]): Promise<ScriptedOpenAIServer> {
  const script = [...turns];
  const requests: CapturedOpenAIRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      url: request.url,
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      body,
    });
    const turn = script.shift();
    if (turn === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture script exhausted" } }));
      return;
    }
    writeTurn(response, turn);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server has no TCP address");
  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
      });
      await closePromise;
    },
  };
}
