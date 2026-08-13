/**
 * Hashing helpers over the Web Crypto `subtle` global.
 *
 * `subtle.digest` is async in every runtime, so the helpers are async
 * — callers that hash on an authenticated path are already async
 * handlers, and store interfaces are async by convention here.
 */

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Constant-time string equality. Compares every character regardless
 * of where the first mismatch sits, so comparison time leaks only the
 * length — which the caller should already have checked or be content
 * to reveal (both operands here are fixed-length digests).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
