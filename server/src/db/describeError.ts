/**
 * Node's connection attempts (e.g. against "localhost" resolving to both
 * IPv4/IPv6) surface as AggregateError with an empty top-level .message —
 * the useful detail is in .errors[]. This unwraps that so /health and
 * logs carry an actually-readable reason instead of "".
 */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    return err.errors.map((e) => describeError(e)).join("; ") || err.name;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${err.message || err.name} (${code})` : err.message || err.name;
  }
  return String(err);
}
