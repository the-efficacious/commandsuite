/**
 * Self-signed TLS certificate generation for csuite.
 *
 * Wraps the `selfsigned` npm package (which is built on node-forge) with
 * csuite's fixed defaults: RSA 2048 + SHA-256, 365-day validity,
 * SANs covering localhost, the IPv4/IPv6 loopbacks, and optionally a
 * user-supplied LAN IP. The cert is marked serverAuth only and
 * non-CA, so browsers that do accept it treat it as an end-entity
 * cert.
 *
 * Note on `selfsigned` v5: `generate()` is async-only as of v5. The
 * cost is a single await during boot; persistence in `https/store.ts`
 * caches the PEMs so we only pay it on first run or on regeneration.
 */

import { X509Certificate } from 'node:crypto';
import { generate, type SubjectAltNameEntry } from 'selfsigned';

export interface GeneratedCert {
  cert: string;
  key: string;
  /** SHA-256 fingerprint of the cert — handy for startup banners. */
  fingerprint: string;
  /** UNIX ms — `notAfter` parsed from the generated cert. */
  expiresAt: number;
}

export interface GenerateCertOptions {
  /**
   * Additional LAN IP to include as a SAN. The server auto-detects
   * one when binding to 0.0.0.0, but callers can override. IPv4 only
   * for v1 — IPv6 link-local SANs are tricky (zone IDs) and nobody
   * actually uses them for LAN.
   */
  lanIp?: string | null;
  /** Cert validity in days. Defaults to 365. */
  validityDays?: number;
}

const DEFAULT_VALIDITY_DAYS = 365;
const DEFAULT_KEY_SIZE = 2048;
const DEFAULT_ALGORITHM = 'sha256';

/**
 * Generate a self-signed cert + key pair for local / LAN HTTPS.
 * Always includes `localhost` DNS SAN and 127.0.0.1/::1 IP SANs;
 * adds `lanIp` as an additional IP SAN if provided.
 */
export async function generateSelfSignedCert(
  options: GenerateCertOptions = {},
): Promise<GeneratedCert> {
  const validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;
  const altNames: SubjectAltNameEntry[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
  ];
  if (options.lanIp && options.lanIp !== '127.0.0.1' && options.lanIp !== '::1') {
    altNames.push({ type: 7, ip: options.lanIp });
  }

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + validityDays * 24 * 60 * 60 * 1000);

  const pems = await generate([{ name: 'commonName', value: 'csuite' }], {
    algorithm: DEFAULT_ALGORITHM,
    keySize: DEFAULT_KEY_SIZE,
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  const parsed = new X509Certificate(pems.cert);
  return {
    cert: pems.cert,
    key: pems.private,
    fingerprint: parsed.fingerprint256,
    expiresAt: Date.parse(parsed.validTo),
  };
}

/**
 * Parse an existing cert PEM and return its `notAfter` timestamp in
 * UNIX ms. Returns null if the PEM is unparsable — callers treat that
 * as "regenerate."
 */
export function certExpiryMs(certPem: string): number | null {
  try {
    const parsed = new X509Certificate(certPem);
    const ms = Date.parse(parsed.validTo);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
