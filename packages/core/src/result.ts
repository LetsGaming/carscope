export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const FAILURE = {
  timeout: "timeout",
  network: "network",
  http: "http",
  blocked: "blocked",
  parse: "parse",
  rateLimited: "rate_limited",
  notFound: "not_found",
  invalid: "invalid",
} as const;

export type FailureKind = (typeof FAILURE)[keyof typeof FAILURE];

export interface AppError {
  readonly kind: FailureKind;
  readonly message: string;
  readonly status?: number;
  readonly retryable: boolean;
}

const RETRYABLE: ReadonlySet<FailureKind> = new Set([
  FAILURE.timeout,
  FAILURE.network,
  FAILURE.rateLimited,
]);

export function failure(kind: FailureKind, message: string, status?: number): AppError {
  return status === undefined
    ? { kind, message, retryable: RETRYABLE.has(kind) }
    : { kind, message, status, retryable: RETRYABLE.has(kind) };
}
