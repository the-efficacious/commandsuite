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
// hard-load probe (deep link must serve the SPA), in-app navigation via
// the router's own popstate entry point, console errors and failed
// requests recorded, and the row judged against its declared
// expectation for --role:
//   clean      → renders the app, hard load `200 app`, zero console
//                errors, zero failed requests
//   restricted → renders the app AND the Restricted callout, zero
//                console errors, zero failed requests (the #220 bar:
//                a refusal is rendered, never fetched-then-refused)
// Also fails if any kind in the router's Route union is missing from
// the manifest — adding a page without a permission story fails here.
//
// Dependencies: a chromium binary (env CHROMIUM, default
// /usr/bin/chromium) and puppeteer-core. Local use: docs/dev/route-walk.mdx.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

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

// ── Completeness: every router kind must be declared. ───────────────
const declared = JSON.parse(readFileSync(manifestPath, 'utf8'));
const routerKinds = JSON.parse(
  execFileSync(process.execPath, [resolve(import.meta.dirname, 'extract-route-kinds.mjs')], {
    encoding: 'utf8',
  }),
);
const declaredKinds = new Set(declared.routes.map((r) => r.kind));
const undeclaredKinds = routerKinds.filter((k) => !declaredKinds.has(k));
if (undeclaredKinds.length > 0) {
  console.error(
    `walk.mjs: route kind(s) present in the router but absent from the manifest: ${undeclaredKinds.join(', ')}\n` +
      '  every page must declare its permission story in scripts/route-walk/manifest.json',
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
      // A declared partial refusal: the page is clean but one panel
      // legitimately renders the Restricted callout for this role
      // (e.g. the DM's peer-activity inspector for a baseline viewer).
      allowRestrictedPanel: (r.allowRestrictedPanel ?? []).includes(ROLE),
      why: r.why ?? null,
    })),
  );

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: true,
  userDataDir: `${args.out}/profile-${ROLE}`,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});
const report = {
  broker: BROKER,
  member: String(args.member),
  role: ROLE,
  startedAt: new Date().toISOString(),
  routes: [],
};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const failedRequests = [];
  page.on('response', (res) => {
    if (res.status() >= 400)
      failedRequests.push(
        `${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`,
      );
  });

  // Sign in through the product's own TOTP form. A code is single-use
  // per 30 s step: on refusal, wait for the next step and retry once.
  await page.goto(`${BROKER}/`, { waitUntil: 'networkidle0', timeout: 45_000 });
  if (await page.$('#totp-code')) {
    let signedIn = false;
    for (let attempt = 1; attempt <= 2 && !signedIn; attempt += 1) {
      await page.$eval('#totp-code', (el) => {
        el.value = '';
      });
      await page.type('#totp-code', totp(String(args.secret)));
      await page.click('button[type=submit]');
      await page.waitForFunction(
        () =>
          !document.querySelector('#totp-code') ||
          document.querySelector('#member-name') ||
          document.querySelector('[role=alert]'),
        { timeout: 20_000 },
      );
      if (await page.$('#member-name')) {
        await page.type('#member-name', String(args.member));
        await page.click('button[type=submit]');
        await page.waitForFunction(
          () => !document.querySelector('#totp-code') || document.querySelector('[role=alert]'),
          { timeout: 20_000 },
        );
      }
      if (!(await page.$('#totp-code'))) {
        signedIn = true;
        break;
      }
      const alert = await page
        .$eval('[role=alert]', (el) => el.textContent?.trim() ?? '')
        .catch(() => '');
      if (attempt === 1) {
        const wait = 31 - (Math.floor(Date.now() / 1000) % 30);
        console.log(`sign-in refused ("${alert}"); retrying in ${wait}s on the next TOTP step`);
        await new Promise((res) => setTimeout(res, wait * 1000));
      } else {
        throw new Error(`sign-in failed: ${alert || 'no alert text'}`);
      }
    }
  }

  async function hardLoad(url) {
    const probe = await browser.newPage();
    try {
      const res = await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const ct = res?.headers()['content-type'] ?? '';
      const status = res?.status() ?? 0;
      const kind = ct.includes('text/html')
        ? 'app'
        : ct.includes('json')
          ? 'api-json'
          : `other(${ct || 'none'})`;
      return `${status} ${kind}`;
    } finally {
      await probe.close();
    }
  }

  for (const r of rows) {
    errors.length = 0;
    failedRequests.length = 0;
    const url = `${BROKER}${r.url}`;
    const entry = { kind: r.kind, url: r.url, role: ROLE, expectation: r.expectation };
    const t0 = Date.now();
    try {
      entry.hardLoad = await hardLoad(url);
      const shellMounted = await page.evaluate(() =>
        document.body.innerText.includes('Jump to member'),
      );
      if (!shellMounted) {
        await page.goto(`${BROKER}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForFunction(() => document.body.innerText.includes('Jump to member'), {
          timeout: 20_000,
        });
      }
      await page.evaluate((path) => {
        window.history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, r.url);
      await page.waitForNetworkIdle({ idleTime: 600, timeout: 30_000 }).catch(() => {});
      await new Promise((res) => setTimeout(res, 400));
      const text = await page.evaluate(() => document.body.innerText);
      entry.consoleErrors = [...errors];
      entry.failedRequests = [...failedRequests];
      entry.rendersApp = /Jump to member/.test(text);
      entry.showsRestricted = /Restricted/.test(text);
      if (args.screenshots) {
        const file = `${args.out}/${ROLE}-${r.kind}${r.url.replace(/[^a-z0-9]+/gi, '-')}.jpg`;
        await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
        entry.screenshot = file;
      }
      const noNoise =
        entry.consoleErrors.length === 0 &&
        entry.failedRequests.length === 0 &&
        entry.hardLoad === '200 app';
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
      entry.hardLoad !== '200 app' ? `hard-load ${entry.hardLoad}` : null,
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
