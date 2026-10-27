import { timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison. */
export function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time check of an Authorization header against the expected bearer token. */
export function bearerMatches(header: string, token: string): boolean {
  return secretMatches(header, `Bearer ${token}`);
}
