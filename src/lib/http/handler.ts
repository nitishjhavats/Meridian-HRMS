import { NextResponse } from "next/server";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import { type AuthContext, requireContext } from "../auth/context";
import { AppError, RateLimitError, ValidationError, correlationId, toErrorBody } from "../errors";
import { describeIssues, fieldIssuesFrom } from "../fieldIssues";
import { InvalidCodePrefix } from "@/domain/employees/code";
import { clientIp } from "./clientIp";

/**
 * Route-handler plumbing.
 *
 * Every API route is wrapped so that the same four things always happen in the
 * same order: parse, authenticate, run the service, map errors. An unexpected
 * throw becomes a 500 with a correlation id — the stack goes to the server log,
 * never to the client.
 */

export interface RouteContext<TParams = Record<string, string>> {
  params: Promise<TParams>;
}

type Handler<TParams> = (
  request: Request,
  context: { ctx: AuthContext; params: TParams },
) => Promise<NextResponse | Response>;

type PublicHandler<TParams> = (
  request: Request,
  context: { params: TParams },
) => Promise<NextResponse | Response>;

function logAndMap(error: unknown, request: Request): NextResponse {
  const id = correlationId();

  if (error instanceof ZodError) {
    // The message names the first field, because the issues beside it are read
    // by almost no form and "check the highlighted fields" highlighted nothing.
    const issues = fieldIssuesFrom(error.issues);
    const validation = new ValidationError(describeIssues(issues), { issues });
    const { status, body } = toErrorBody(validation, id);
    return NextResponse.json(body, { status });
  }

  // The domain refuses a code prefix with a plain Error: it has no dependency on
  // the app's error vocabulary, and the routes that take one leave the shape
  // check to it "because it owns the message people read". Left as a plain
  // Error it fell through to the 500 below, so clearing the employee-code box
  // or typing a one-letter invoice prefix got a stack trace in the log and
  // "something went wrong on our side" on the screen -- the one message it
  // owned never arrived.
  if (error instanceof InvalidCodePrefix) {
    error = new ValidationError(error.message);
  }

  if (!(error instanceof AppError)) {
    console.error(`[api] ${request.method} ${new URL(request.url).pathname} [${id}]`, error);
  } else if (error.httpStatus >= 500) {
    console.error(`[api] ${request.method} ${new URL(request.url).pathname} [${id}]`, error.message);
  }

  const { status, body } = toErrorBody(error, id);
  const response = NextResponse.json(body, { status });
  if (error instanceof RateLimitError) {
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
  }
  return response;
}

/** Wraps an authenticated route handler. */
export function route<TParams = Record<string, string>>(handler: Handler<TParams>) {
  return async (request: Request, routeContext: RouteContext<TParams>): Promise<Response> => {
    try {
      const ctx = await requireContext();
      const params = (await routeContext?.params) ?? ({} as TParams);
      return await handler(request, { ctx, params });
    } catch (error) {
      return logAndMap(error, request);
    }
  };
}

/** Wraps a route that must work without a session (login, forgot password). */
export function publicRoute<TParams = Record<string, string>>(handler: PublicHandler<TParams>) {
  return async (request: Request, routeContext: RouteContext<TParams>): Promise<Response> => {
    try {
      const params = (await routeContext?.params) ?? ({} as TParams);
      return await handler(request, { params });
    } catch (error) {
      return logAndMap(error, request);
    }
  };
}

/**
 * Parses and validates a JSON body.
 *
 * Typed against an `unknown` input so schemas that coerce or transform (query
 * strings are always strings on the wire) are accepted without casting at every
 * call site.
 */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("The request body was not valid JSON.");
  }
  return schema.parse(raw);
}

/** Parses and validates the query string. Repeated keys arrive as arrays. */
export function parseQuery<T>(request: Request, schema: ZodType<T, ZodTypeDef, unknown>): T {
  const url = new URL(request.url);
  const entries: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    entries[key] = values.length > 1 ? values : (values[0] as string);
  }
  return schema.parse(entries);
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 }) as NextResponse;
}

/** Client metadata for audit rows and rate-limit keys. */
export function requestMeta(request: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: clientIp(request.headers),
    userAgent: request.headers.get("user-agent"),
  };
}

/** Streams a CSV download. */
export function csvResponse(filename: string, rows: (string | number | null)[][]): NextResponse {
  const escape = (value: string | number | null): string => {
    if (value == null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const body = rows.map((row) => row.map(escape).join(",")).join("\r\n");

  return new NextResponse(`﻿${body}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  }) as NextResponse;
}
