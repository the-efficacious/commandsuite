// Minimal Chrome DevTools Protocol client for the route walker —
// deliberately dependency-free (obj-mtg1kwxb-m review: the previous
// puppeteer-core tree failed the repository's dependency-review
// gate). Node ≥ 22 ships a WebSocket client; Chromium speaks CDP;
// nothing else is needed for "load a page, read its text, count its
// errors".
//
// Surface: launchBrowser() spawns a headless Chromium-family binary
// with --remote-debugging-port=0 and returns a connected CdpClient.
// client.createSession() attaches a new tab and returns a
// CdpSession with send(method, params), on(event, handler), and
// close(). Sessions are independent CDP flat-mode sessions in the
// same browser context, so they share cookies (sign in once, probe
// hard loads from a second tab).
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** Wait for the "DevTools listening on ws://…" line on stderr. */
function devtoolsUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`browser did not print a DevTools URL within ${timeoutMs}ms:\n${buffer}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited with code ${code} before DevTools was ready:\n${buffer}`));
    });
  });
}

export async function launchBrowser({ executable, userDataDir, timeoutMs = 30_000 }) {
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--window-size=1400,900',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const url = await devtoolsUrl(child, timeoutMs);
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return new CdpClient(child, ws);
}

class CdpClient {
  #child;
  #ws;
  #nextId = 1;
  #pending = new Map(); // id -> {resolve, reject}
  #sessions = new Map(); // sessionId -> CdpSession

  constructor(child, ws) {
    this.#child = child;
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(String(event.data)));
  }

  #onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method !== undefined && msg.sessionId !== undefined) {
      this.#sessions.get(msg.sessionId)?.dispatch(msg.method, msg.params);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const frame = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    this.#ws.send(JSON.stringify(frame));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  /** Open a new tab and attach a flat-mode session to it. */
  async createSession() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const session = new CdpSession(this, sessionId, targetId);
    this.#sessions.set(sessionId, session);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    return session;
  }

  async closeSession(session) {
    this.#sessions.delete(session.sessionId);
    await this.send('Target.closeTarget', { targetId: session.targetId }).catch(() => {});
  }

  async close() {
    try {
      await this.send('Browser.close');
    } catch {
      this.#child.kill('SIGKILL');
    }
    this.#ws.close();
  }
}

class CdpSession {
  #client;
  #handlers = new Map(); // method -> Set<handler>

  constructor(client, sessionId, targetId) {
    this.#client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.#client.send(method, params, this.sessionId);
  }

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method).add(handler);
  }

  dispatch(method, params) {
    for (const handler of this.#handlers.get(method) ?? []) handler(params);
  }

  close() {
    return this.#client.closeSession(this);
  }

  /** Evaluate an expression in the page; returns the by-value result. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`evaluate threw: ${exceptionDetails.text} ${result?.description ?? ''}`);
    }
    return result?.value;
  }

  /** Poll `expression` until truthy or `timeoutMs` elapses. */
  async waitFor(expression, timeoutMs = 20_000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate(expression)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  /**
   * Wait until no CDP-tracked request has been in flight for
   * `idleMs`. Callers must have installed trackNetwork() first.
   */
  async networkIdle(tracker, idleMs = 600, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (tracker.inflight.size === 0 && Date.now() - tracker.lastEventAt >= idleMs) return;
      if (Date.now() > deadline) return; // best-effort, like waitForNetworkIdle
      await new Promise((res) => setTimeout(res, 100));
    }
  }
}

/**
 * Record request lifecycle on a session: `inflight` request ids,
 * `failed` (status ≥ 400 or transport error) `"<status> <METHOD> <path>"`
 * strings, and the main-document response for hard-load probes.
 */
export function trackNetwork(session) {
  const tracker = {
    inflight: new Map(), // requestId -> {method, url}
    failed: [],
    document: null, // {status, mimeType} of the last main-frame document response
    lastEventAt: Date.now(),
  };
  session.on('Network.requestWillBeSent', (p) => {
    tracker.inflight.set(p.requestId, { method: p.request.method, url: p.request.url });
    tracker.lastEventAt = Date.now();
  });
  session.on('Network.responseReceived', (p) => {
    tracker.lastEventAt = Date.now();
    if (p.type === 'Document' && p.frameId !== undefined) {
      tracker.document = { status: p.response.status, mimeType: p.response.mimeType };
    }
    if (p.response.status >= 400) {
      const req = tracker.inflight.get(p.requestId);
      const path = safePathname(p.response.url);
      tracker.failed.push(`${p.response.status} ${req?.method ?? 'GET'} ${path}`);
    }
  });
  const settle = (p) => {
    tracker.inflight.delete(p.requestId);
    tracker.lastEventAt = Date.now();
  };
  session.on('Network.loadingFinished', settle);
  session.on('Network.loadingFailed', (p) => {
    // Aborted fetches on route change are normal; real transport
    // failures (DNS, refused) surface as errorText without cancel.
    const req = tracker.inflight.get(p.requestId);
    if (!p.canceled && req !== undefined) {
      tracker.failed.push(`ERR(${p.errorText}) ${req.method} ${safePathname(req.url)}`);
    }
    settle(p);
  });
  return tracker;
}

/** Record console errors and uncaught exceptions on a session. */
export function trackConsole(session) {
  const errors = [];
  session.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      errors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
  });
  session.on('Runtime.exceptionThrown', (p) => {
    errors.push(
      `pageerror: ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description ?? ''}`,
    );
  });
  return errors;
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
