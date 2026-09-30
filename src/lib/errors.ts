/**
 * The application's error vocabulary.
 *
 * Anything thrown from a service is one of these; `lib/http/handler.ts` maps them
 * to responses. Unknown errors become a generic 500 with a correlation id — a
 * stack trace never reaches a user.
 */

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SEAT_LIMIT"
  | "FEATURE_DISABLED"
  | "SUBSCRIPTION_READ_ONLY"
  | "PAYROLL_LOCKED"
  | "EXTERNAL_SERVICE"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;
  /** Safe to show a user verbatim. */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    message: string,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Please check the highlighted fields.", details?: unknown) {
    super("VALIDATION", 422, message, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super("UNAUTHORIZED", 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that.") {
    super("FORBIDDEN", 403, message);
  }
}

/**
 * Used for genuinely missing rows *and* for rows belonging to another tenant —
 * telling a stranger that an id exists but is not theirs is itself a leak.
 */
export class NotFoundError extends AppError {
  constructor(what = "That record") {
    super("NOT_FOUND", 404, `${what} could not be found.`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", 409, message, { details });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Too many attempts. Please try again shortly.") {
    super("RATE_LIMITED", 429, message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SeatLimitError extends AppError {
  constructor(message: string) {
    super("SEAT_LIMIT", 402, message);
  }
}

export class FeatureDisabledError extends AppError {
  constructor(moduleKey: string) {
    super("FEATURE_DISABLED", 403, `The ${moduleKey} module is not enabled for this organisation.`);
  }
}

export class SubscriptionReadOnlyError extends AppError {
  constructor(message = "Your subscription needs attention. The app is read-only until payment is confirmed.") {
    super("SUBSCRIPTION_READ_ONLY", 402, message);
  }
}

export class PayrollLockedError extends AppError {
  constructor(message = "This payroll run is locked. Unlock it to make changes.") {
    super("PAYROLL_LOCKED", 409, message);
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, message?: string, cause?: unknown) {
    super("EXTERNAL_SERVICE", 502, message ?? `${service} is not responding right now. Please try again.`, {
      cause,
    });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Short, human-typable id used to tie a user-facing error to a server log line. */
export function correlationId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now().toString(36).slice(-4).toUpperCase();
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    correlationId?: string;
  };
}

export function toErrorBody(error: unknown, id: string): { status: number; body: ErrorBody } {
  if (isAppError(error)) {
    return {
      status: error.httpStatus,
      body: {
        error: {
          code: error.code,
          message: error.expose ? error.message : "Something went wrong.",
          ...(error.details !== undefined ? { details: error.details } : {}),
          correlationId: id,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL",
        message: "Something went wrong on our side. Quote this reference if you contact support.",
        correlationId: id,
      },
    },
  };
}
