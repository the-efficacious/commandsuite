/**
 * `csuite-sdk` — contract and runtime client for csuite.
 *
 * The root entry point re-exports everything for convenience. Consumers
 * that only want types or schemas should import the subpath entries:
 *
 *   import type { Member, Message } from 'csuite-sdk/types';
 *   import { PushPayloadSchema } from 'csuite-sdk/schemas';
 *   import { DEFAULT_PORT, PATHS } from 'csuite-sdk/protocol';
 *   import { Client, ClientError } from 'csuite-sdk/client';
 */

export * from './client.js';
export * from './protocol.js';
export * from './schemas.js';
export * from './types.js';
