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

/** A marker declaration is a string, or one string per role. */
function resolveMarker(declaration) {
  if (declaration === undefined || declaration === null) return undefined;
  if (typeof declaration === 'string') return declaration;
  return declaration[ROLE];
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
      // Text unique to THIS view, so a clean pass proves the route
      // rendered itself. Without it the only positive assertion was
      // the shell, which survives in-app navigation -- a build with
      // the objectives page deleted walked green, because /objectives
      // fell through to home and home has a shell like everything
      // else. `markers` (parallel to urls) where the row's URLs render
      // different views; `marker` where one string covers them all.
      // Templated like the URLs, so a marker can name the fixture the
      // row is pinned to rather than hard-coding a seeded slug.
      // A marker may be one string, or one per role. Views legitimately
      // differ by role -- a profile tab the viewer lacks the permission
      // for falls back to overview by design (MemberProfile.tsx
      // `effectiveTab`), and a DM with yourself renders no peer header
      // -- so a single string per URL forces the declaration down to
      // whatever both roles happen to share, which is how you end up
      // asserting the shell again.
      marker: fill(
        String(
          resolveMarker(
            Array.isArray(r.markers) ? r.markers[r.urls.indexOf(template)] : r.marker,
          ) ?? '',
        ),
      ),
      // A declared partial refusal: the page is clean but one panel
      // legitimately renders the Restricted callout for this role
      // (e.g. the DM's peer-activity inspector for a baseline viewer).
      allowRestrictedPanel: (r.allowRestrictedPanel ?? []).includes(ROLE),
      why: r.why ?? null,
      // Landing on home IS this row's contract (the two pseudo rows and
      // home itself), so its marker is allowed to be home's.
      rendersHome: r.rendersHome === true,
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

  // Everything the page can still tell us at the moment something
  // threw. Screenshots here are unconditional, unlike --screenshots
  // (which also captures the healthy walk): a red gate with no picture
  // and no console output costs whoever reads it a full reproduction.
  async function diagnose(slug) {
    const out = { consoleErrors: [...errors], failedRequests: [...network.failed] };
    try {
      out.location = await page.evaluate(`location.pathname + location.search`);
      // Generous: the shell chrome alone runs past a thousand
      // characters, so a short slice captures the navigation and
      // clips the view that actually failed.
      out.bodyText = String(await page.evaluate(`document.body.innerText`)).slice(0, 4000);
    } catch (err) {
      out.bodyText = `unreadable: ${err.message}`;
    }
    try {
      const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      const file = `${args.out}/failure-${slug.replace(/[^a-z0-9]+/gi, '-')}.jpg`;
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      out.screenshot = file;
    } catch (err) {
      out.screenshot = `unavailable: ${err.message}`;
    }
    return out;
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

  // The loop above ends when the TOTP field is GONE, which is the
  // absence of a login form and not the presence of a session: a blank
  // page, a crashed render and an error view all satisfy it. Assert the
  // signed-in shell itself, once, and fail here with the page's own
  // evidence -- otherwise a session we never had is rediscovered 28
  // times as a 21 s timeout per route, which is how a ten-minute CI
  // failure came to report nothing but the symptom.
  try {
    await page.waitFor(`document.body.innerText.includes('Jump to member')`, 30_000);
  } catch {
    const d = await diagnose(`${ROLE}-signin`);
    throw new Error(
      `signed in but the shell never mounted at ${d.location ?? '?'}` +
        ` — ${d.consoleErrors.length} console errors, ${d.failedRequests.length} failed requests` +
        `${d.screenshot ? `, screenshot ${d.screenshot}` : ''}\n` +
        `  console: ${JSON.stringify(d.consoleErrors.slice(0, 5))}\n` +
        `  failed:  ${JSON.stringify(d.failedRequests.slice(0, 5))}\n` +
        `  body:    ${JSON.stringify(String(d.bodyText).slice(0, 300))}`,
    );
  }

  // ── The markers' own known-bad input ────────────────────────────
  //
  // Unknown paths fall through to home, so a marker that also appears
  // on home cannot tell "this route rendered" from "this route no
  // longer exists". That is not hypothetical: deleting the objectives
  // route from the router and rebuilding left this gate GREEN, because
  // the marker chosen for /objectives was a string home happens to
  // render too. Check every marker against home's actual text before
  // walking, rather than trusting that whoever declared it looked far
  // enough down the page.
  // Settle first. The shell appears long before home's panels resolve,
  // and reading too early gives a half-rendered page that flags
  // nothing -- which is exactly what this check did on its first run,
  // passing a marker that a fully-loaded home does render.
  await page.networkIdle(network, 600, 30_000);
  await new Promise((res) => setTimeout(res, 600));
  const homeText = (await page.evaluate(`document.body.innerText`)).replace(/\s+/g, ' ');
  const ambiguous = rows.filter(
    (r) => r.expectation === 'clean' && !r.rendersHome && homeText.includes(String(r.marker)),
  );
  if (ambiguous.length > 0) {
    console.error('walk.mjs: these markers also appear on home, so they prove nothing:');
    for (const r of ambiguous) {
      console.error(`  - ${r.kind} ${r.url}: ${JSON.stringify(r.marker)}`);
    }
    console.error(
      '  an unknown path renders home, so such a route walks green even when its view is gone.',
    );
    console.error('  declare `rendersHome: true` if landing on home IS the contract for that row.');
    process.exit(1);
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
      // The shell is not the view. A restricted route renders the
      // callout instead of its content, so the marker is asserted
      // only where the row expects a clean render.
      // Matched against whitespace-collapsed text: a marker is a
      // content assertion, not a layout one. `#` and a channel name
      // are separate elements, so the raw innerText carries a newline
      // between them that no sane declaration would predict — and a
      // marker that has to guess the DOM's line breaks would fail on
      // every restyle, which is the sort of gate people learn to
      // ignore.
      const flat = text.replace(/\s+/g, ' ');
      entry.rendersOwnView =
        r.expectation === 'restricted' ? null : flat.includes(String(r.marker));
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
          ? entry.rendersApp &&
            entry.rendersOwnView &&
            (r.allowRestrictedPanel || !entry.showsRestricted) &&
            noNoise
          : entry.rendersApp && entry.showsRestricted && noNoise;
      // Not every failure throws — a wrong view renders perfectly well.
      // Evidence attaches to any red route, not just the ones that
      // raised, or the quiet failures are the least diagnosable ones.
      if (!entry.ok) Object.assign(entry, await diagnose(`${ROLE}-${r.kind}`));
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
      // Everything below is already in memory when the throw happens.
      // An earlier version recorded only `error` and `ms`, so a red
      // gate said what timed out and never why -- ten minutes of CI
      // for one string restating the symptom. The failure path is the
      // only path where this evidence is worth anything.
      Object.assign(entry, await diagnose(`${ROLE}-${r.kind}`));
    }
    entry.ms = Date.now() - t0;
    report.routes.push(entry);
    const detail = [
      entry.error ?? null,
      entry.hardLoad !== r.hardLoad ? `hard-load ${entry.hardLoad} (wanted ${r.hardLoad})` : null,
      entry.rendersApp && entry.rendersOwnView === false
        ? `shell mounted but ${JSON.stringify(r.marker)} absent — wrong view for this URL`
        : null,
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
