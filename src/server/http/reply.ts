import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdapterState } from "./types.ts";
/**
 * Machine-readable error codes with HTTP status mapping.
 */
export const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  unknown_model: 400,
  unknown_session: 404,
  unknown_job: 404,
  unauthorized: 401,
  provider_error: 502,
  rate_limited: 429,
  internal: 500,
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, code: string, message: string): void {
  sendJson(res, ERROR_STATUS[code] ?? 500, { error: { code, message } });
}

export function sendErrorWithRequestId(
  res: ServerResponse,
  code: string,
  message: string,
  requestId: string | undefined,
): void {
  const status = ERROR_STATUS[code] ?? 500;
  sendJson(res, status, {
    ...(requestId !== undefined ? { requestId } : {}),
    error: { code, message },
  });
}

/** Bearer-token gate for the contract; unset = auth disabled. */
export function checkAuth(st: AdapterState, req: IncomingMessage): boolean {
  if (!st.apiToken) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${st.apiToken}`;
}

/** Reply envelope: the message type echoes the request's, with requestId. */
export function sendMessage(
  res: ServerResponse,
  status: number,
  type: string,
  data: unknown,
  requestId: string | undefined,
): void {
  sendJson(res, status, {
    type,
    version: 1,
    ...(requestId !== undefined ? { requestId } : {}),
    data,
  });
}
