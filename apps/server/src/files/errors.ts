/**
 * Typed errors for the csuite filesystem layer. The app layer maps these
 * to HTTP status codes: `not_found` → 404, `forbidden` → 403,
 * `exists` / `not_a_directory` / `is_a_directory` → 409,
 * `too_large` → 413, everything else → 400.
 */

export type FsErrorCode =
  | 'not_found'
  | 'exists'
  | 'not_a_directory'
  | 'is_a_directory'
  | 'not_empty'
  | 'forbidden'
  | 'invalid_input'
  | 'too_large'
  | 'corrupt';

export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = 'FsError';
    this.code = code;
  }
}
