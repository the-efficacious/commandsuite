#!/usr/bin/env node
// Walk every manifest route of the CommandSuite web UI as one role,
// headless, and assert each route's declared expectation
// (obj-mtg1kwxb-m — the CI gate grown from the obj-mtfkktdr-7 kit).
//
// Usage: node walk.mjs --broker <url> --member <name> --secret <totp-secret-file>
//                      --role baseline|admin --fixtures <fixtures.json> --out <dir>
//                      [--manifest <path>] [--screenshots] [--only <kind>]
//
// Signs in through the product's own TOTP form, then per manifest URL:
// hard-load probe (what the server serves for the deep link), in-app
// navigation via the router's own popstate entry point, console errors
// and failed requests recorded over CDP, and the row judged against
// its declared expectation for --role:
//   clean      → renders the app, hard load `200 app` (unless the row
//                declares another hardLoad contract), zero console
//                errors, zero failed requests
//   restricted → renders the app AND the Restricted callout, zero
//                console errors, zero failed requests (the #220 bar:
//                a refusal is rendered, never fetched-then-refused)
// Before walking, the manifest is validated against the router source
// (scripts/route-walk/contract.mjs): kinds in both directions,
// member-profile tab variants against PROFILE_TABS, duplicates,
// pseudo-row rules — adding a page or a profile tab without a
// permission story fails here by name.
//
// The browser is driven over raw CDP (scripts/route-walk/cdp.mjs) —
// no npm dependency; any Chromium-family binary works (env CHROMIUM,
// default /usr/bin/chromium). Local use: docs/dev/route-walk.mdx.
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, trackConsole, trackNetwork } from './cdp.mjs';
import { validateManifest } from './contract.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--'))
      acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
for (const k of ['broker', 'member', 'secret', 'role', 'fixtures', 'out']) {
  if (!args[k]) {
    console.error(`walk.mjs: --${k} is required`);
    process.exit(2);
  }
}
const ROLE = String(args.role);
if (ROLE !== 'baseline' && ROLE !== 'admin') {
  console.error(`walk.mjs: --role must be baseline or admin (got ${ROLE})`);
  process.exit(2);
}
const BROKER = String(args.broker).replace(/\/+$/, '');
// biome-ignore lint/suspicious/noUndeclaredEnvVars: operator-supplied override, documented in docs/dev/route-walk.mdx
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium';
const manifestPath = resolve(
  String(args.manifest ?? new URL('./manifest.json', import.meta.url).pathname),
);
const fixtures = {
  selfName: String(args.member),
  ...JSON.parse(readFileSync(String(args.fixtures), 'utf8')),
};
mkdirSync(String(args.out), { recursive: true });

// ── Contract: manifest ↔ router parity, validated before walking. ───
const declared = JSON.parse(readFileSync(manifestPath, 'utf8'));
const contractErrors = validateManifest(declared);
if (contractErrors.length > 0) {
  console.error('walk.mjs: the manifest does not match the router contract:');
  for (const error of contractErrors) console.error(`  - ${error}`);
  console.error(
    '  every page (and profile tab) must declare its permission story in scripts/route-walk/manifest.json',
  );
  process.exit(1);
}

// ── URL templates → concrete URLs via the seeded fixtures. ──────────
function fill(template) {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key) => {
    if (fixtures[key] === undefined) {
      throw new Error(`fixture value '${key}' missing from ${args.fixtures}`);
    }
    return fixtures[key];
  });
}

function totp(secretFile) {
  const secret = readFileSync(secretFile, 'utf8').trim().replace(/=+$/, '').toUpperCase();
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const rows = declared.routes
  .filter((r) => !args.only || r.kind === args.only)
  .flatMap((r) =>
    r.urls.map((template) => ({
      kind: r.kind,
      url: fill(template),
      expectation: r.roles[ROLE],
      // What the server must serve for a hard load of this URL.
      // Default: the SPA shell. Pseudo rows pin other contracts
      // (e.g. unknown paths hard-load as 404 while in-app they fall
      // through to home).
      hardLoad: r.hardLoad ?? '200 app',
      // A declared partial refusal: the page is clean but one panel
      // legitimately renders the Restricted callout for this role
      // (e.g. the DM's peer-activity inspector for a baseline viewer).
      allowRestrictedPanel: (r.allowRestrictedPanel ?? []).includes(ROLE),
      why: r.why ?? null,
    })),
  );

const browser = await launchBrowser({
  executable: CHROMIUM,
  userDataDir: `${args.out}/profile-${ROLE}`,
});
const report = {
  broker: BROKER,
  member: String(args.member),
  role: ROLE,
  startedAt: new Date().toISOString(),
  routes: [],
};
try {
  const page = await browser.createSession();
  const network = trackNetwork(page);
  const errors = trackConsole(page);

  async function goto(url) {
    await page.send('Page.navigate', { url });
    await page.networkIdle(network, 600, 45_000);
  }

  // Sign in through the product's own TOTP form. A code is single-use
  // per 30 s step: on refusal, wait for the next step and retry once.
  // Values are set through the DOM with an input event so the form
  // framework sees them (CDP has no key-by-key typing shortcut).
  const setField = (selector, value) =>
    page.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
        `if (!el) return false;` +
        `el.value = ${JSON.stringify(value)};` +
        `el.dispatchEvent(new Event('input', { bubbles: true }));` +
        `return true; })()`,
    );
  const submit = () =>
    page.evaluate(`document.querySelector('button[type=submit]')?.click() !== undefined`);

  await goto(`${BROKER}/`);
  if (await page.evaluate(`Boolean(document.querySelector('#totp-code'))`)) {
    let signedIn = false;
    for (let attempt = 1; attempt <= 2 && !signedIn; attempt += 1) {
      await setField('#totp-code', totp(String(args.secret)));
      await submit();
      await page.waitFor(
        `!document.querySelector('#totp-code') || document.querySelector('#member-name') || document.querySelector('[role=alert]')`,
      );
      if (await page.evaluate(`Boolean(document.querySelector('#member-name'))`)) {
        await setField('#member-name', String(args.member));
        await submit();
        await page.waitFor(
          `!document.querySelector('#totp-code') || document.querySelector('[role=alert]')`,
        );
      }
      if (!(await page.evaluate(`Boolean(document.querySelector('#totp-code'))`))) {
        signedIn = true;
        break;
      }
      const alert = await page.evaluate(
        `document.querySelector('[role=alert]')?.textContent?.trim() ?? ''`,
      );
      if (attempt === 1) {
        const wait = 31 - (Math.floor(Date.now() / 1000) % 30);
        console.log(`sign-in refused ("${alert}"); retrying in ${wait}s on the next TOTP step`);
        await new Promise((res) => setTimeout(res, wait * 1000));
      } else {
        throw new Error(`sign-in failed: ${alert || 'no alert text'}`);
      }
    }
  }

  // Hard-load probe from a second tab in the same browser context
  // (shares the session cookie): what does the server actually serve
  // for this deep link?
  async function hardLoad(url) {
    const probe = await browser.createSession();
    const probeNet = trackNetwork(probe);
    try {
      await probe.send('Page.navigate', { url });
      await probe.networkIdle(probeNet, 400, 30_000);
      const doc = probeNet.document;
      if (doc === null) return 'no response';
      const kind = doc.mimeType.includes('html')
        ? 'app'
        : doc.mimeType.includes('json')
          ? 'api-json'
          : `other(${doc.mimeType || 'none'})`;
      return doc.status === 200 ? `${doc.status} ${kind}` : `${doc.status}`;
    } finally {
      await probe.close();
    }
  }

  for (const r of rows) {
    errors.length = 0;
    network.failed.length = 0;
    const url = `${BROKER}${r.url}`;
    const entry = {
      kind: r.kind,
      url: r.url,
      role: ROLE,
      expectation: r.expectation,
      hardLoadExpected: r.hardLoad,
    };
    const t0 = Date.now();
    try {
      entry.hardLoad = await hardLoad(url);
      const shellMounted = await page.evaluate(
        `document.body.innerText.includes('Jump to member')`,
      );
      if (!shellMounted) {
        await goto(`${BROKER}/`);
        await page.waitFor(`document.body.innerText.includes('Jump to member')`);
      }
      await page.evaluate(
        `(() => { window.history.pushState(null, '', ${JSON.stringify(r.url)});` +
          `window.dispatchEvent(new PopStateEvent('popstate')); })()`,
      );
      await page.networkIdle(network, 600, 30_000);
      await new Promise((res) => setTimeout(res, 400));
      const text = await page.evaluate(`document.body.innerText`);
      entry.consoleErrors = [...errors];
      // The hard-load probe's own 4xx (e.g. a pinned 404 contract) is
      // the probe's measurement, not page noise — the page tracker
      // only sees the in-app navigation's requests.
      entry.failedRequests = [...network.failed];
      entry.rendersApp = /Jump to member/.test(text);
      entry.showsRestricted = /Restricted/.test(text);
      if (args.screenshots) {
        const shot = await page.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 70,
        });
        const file = `${args.out}/${ROLE}-${r.kind}${r.url.replace(/[^a-z0-9]+/gi, '-')}.jpg`;
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        entry.screenshot = file;
      }
      const noNoise =
        entry.consoleErrors.length === 0 &&
        entry.failedRequests.length === 0 &&
        entry.hardLoad === r.hardLoad;
      entry.ok =
        r.expectation === 'clean'
          ? entry.rendersApp && (r.allowRestrictedPanel || !entry.showsRestricted) && noNoise
          : entry.rendersApp && entry.showsRestricted && noNoise;
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
    }
    entry.ms = Date.now() - t0;
    report.routes.push(entry);
    const detail = [
      entry.error ?? null,
      entry.hardLoad !== r.hardLoad ? `hard-load ${entry.hardLoad} (wanted ${r.hardLoad})` : null,
      entry.consoleErrors?.length ? `${entry.consoleErrors.length} console errors` : null,
      entry.failedRequests?.length ? `${entry.failedRequests.length} failed requests` : null,
      r.expectation === 'restricted' && !entry.showsRestricted ? 'Restricted not rendered' : null,
      r.expectation === 'clean' && entry.showsRestricted && !r.allowRestrictedPanel
        ? 'unexpectedly Restricted'
        : null,
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      `${entry.ok ? 'ok  ' : 'FAIL'} [${ROLE}] ${r.kind.padEnd(22)} ${r.url}${detail ? `  [${detail}]` : ''}  ${entry.ms}ms`,
    );
  }
} finally {
  await browser.close();
}
report.finishedAt = new Date().toISOString();
writeFileSync(`${args.out}/report-${ROLE}.json`, `${JSON.stringify(report, null, 2)}\n`);
const failed = report.routes.filter((r) => !r.ok);
console.log(
  `\n[${ROLE}] ${report.routes.length - failed.length}/${report.routes.length} routes clean; report at ${args.out}/report-${ROLE}.json`,
);
if (failed.length > 0) {
  console.log(`failing: ${failed.map((f) => `${f.kind} ${f.url}`).join('; ')}`);
}
process.exit(failed.length ? 1 : 0);
