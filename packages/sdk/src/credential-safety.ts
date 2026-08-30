/**
 * Plaintext CommandSuite bearer-token shape.
 *
 * The delimiters are part of the match: a longer base64url word that merely
 * begins with a token-looking prefix is not a credential. Keep this helper at
 * the wire-contract layer so broker ingress and runner egress cannot drift.
 */
export const BEARER_TOKEN_PATTERN =
  /(?:^|[^A-Za-z0-9_-])csuite_[A-Za-z0-9_-]{43}(?=$|[^A-Za-z0-9_-])/;

/** True when `text` contains a complete plaintext CommandSuite bearer token. */
export function containsBearerToken(text: string): boolean {
  return BEARER_TOKEN_PATTERN.test(text);
}
