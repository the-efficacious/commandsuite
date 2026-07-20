/**
 * HTTP/2 server factory with hot-reloadable TLS context.
 *
 * Exposes a bundle suitable for passing straight into
 * `@hono/node-server`'s `serve({ createServer, serverOptions, ... })`
 * hook, plus a `reloadCert()` that swaps the active `SecureContext`
 * in place. New TLS handshakes after `reloadCert` see the new cert;
 * in-flight sessions stay on the old one until they reconnect.
 *
 * Why HTTP/2 is the default:
 *   - SSE over HTTP/1.1 is capped at 6 connections per origin by
 *     browsers, so multi-tab / background-tab patterns deadlock.
 *     HTTP/2 multiplexes streams over one connection — no cap.
 *   - `allowHTTP1: true` keeps non-HTTP/2 clients (curl defaults,
 *     older tools) working on the same listener via ALPN negotiation.
 *
 * The `SNICallback` trick is the whole reason this module exists:
 *   - `http2.createSecureServer({ cert, key })` bakes the cert into
 *     the server at construction time.
 *   - `SNICallback` is consulted on every TLS handshake to supply a
 *     per-servername context.
 *   - We point SNICallback at a mutable closure variable, so
 *     `reloadCert()` is just a reassignment — no server restart,
 *     no socket churn, no downtime.
 */

import { createSecureServer as createHttp2SecureServer } from 'node:http2';
import { createSecureContext, type SecureContext } from 'node:tls';

export interface Http2ServerFactory {
  /** Pass into `serve({ createServer: factory.createServer, ... })`. */
  createServer: typeof createHttp2SecureServer;
  /** Pass into `serve({ serverOptions: factory.serverOptions, ... })`. */
  serverOptions: Record<string, unknown>;
  /**
   * Swap the active TLS context without dropping existing sessions.
   * Called by the future ACME renewal loop; in v1 it's a no-op after
   * the initial generation unless you explicitly wire it up.
   */
  reloadCert: (cert: string, key: string) => void;
}

/**
 * Build an HTTP/2 + HTTPS factory pre-loaded with `initial` cert/key.
 * The returned `createServer` and `serverOptions` are pointer-stable
 * — you can keep referencing them across reloads.
 */
export function createHttp2ServerFactory(initial: {
  cert: string;
  key: string;
}): Http2ServerFactory {
  let currentContext: SecureContext = createSecureContext({
    cert: initial.cert,
    key: initial.key,
  });

  const serverOptions: Record<string, unknown> = {
    // Default cert used during the initial TLS negotiation before
    // SNICallback fires. Without these, Node refuses to construct
    // the server.
    cert: initial.cert,
    key: initial.key,
    // Allow HTTP/1.1 clients to connect to the same listener — ALPN
    // picks `h2` for modern browsers and `http/1.1` for curl, etc.
    allowHTTP1: true,
    // Hot-reload hook: every handshake asks for a fresh context.
    SNICallback: (
      _servername: string,
      callback: (err: Error | null, ctx?: SecureContext) => void,
    ) => {
      callback(null, currentContext);
    },
  };

  return {
    createServer: createHttp2SecureServer,
    serverOptions,
    reloadCert(cert, key) {
      currentContext = createSecureContext({ cert, key });
    },
  };
}
