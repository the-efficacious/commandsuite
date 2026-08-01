#!/usr/bin/env node

/**
 * Read-only real-corpus probe for persistent briefing preservation.
 *
 * Usage:
 *   node scripts/measure-briefing-capture.mjs <team-db> <activity-db> <member> [registered-literal] [wire-request]
 *
 * The probe prints hashes and counts only; it never prints instruction or
 * secret text. Build csuite-core and csuite-server first so imports describe
 * the checked tree rather than stale dist output.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { briefingCaptureExemptions } from '../apps/server/dist/run.js';
import {
  anthropicToGenAi,
  clearRegisteredSecretValues,
  openaiResponsesToGenAi,
  redactJson,
  registerSecretValues,
} from '../packages/core/dist/index.js';

const [teamPath, activityPath, memberName, registeredLiteral = memberName, wireRequest] =
  process.argv.slice(2);
if (!teamPath || !activityPath || !memberName) {
  console.error('usage: measure-briefing-capture.mjs <team-db> <activity-db> <member>');
  process.exit(2);
}

const hash = (text) => createHash('sha256').update(text).digest('hex');
const teamDb = new DatabaseSync(teamPath, { readOnly: true });
const activityDb = new DatabaseSync(activityPath, { readOnly: true });
const teamRow = teamDb.prepare('SELECT name, context FROM team WHERE id = 1').get();
const memberRows = teamDb
  .prepare(
    'SELECT name, role_title, role_description, instructions, raw_permissions FROM members ORDER BY insertion_order',
  )
  .all();
const selfRow = memberRows.find((row) => row.name === memberName);
if (!teamRow || !selfRow) throw new Error(`member '${memberName}' not found`);

const memberFrom = (row) => ({
  name: row.name,
  role: { title: row.role_title, description: row.role_description },
  permissions: JSON.parse(row.raw_permissions),
  instructions: row.instructions,
});
const self = memberFrom(selfRow);
const input = {
  self,
  team: { name: teamRow.name, context: teamRow.context, permissionPresets: {} },
  teammates: memberRows.map((row) => {
    const member = memberFrom(row);
    return { name: member.name, role: member.role, permissions: member.permissions };
  }),
  openObjectives: [],
};
const exemptions = briefingCaptureExemptions(input);
const targetBlock = exemptions.find((block) => block.includes(registeredLiteral));
if (!targetBlock) {
  throw new Error(`no composed briefing block contains the requested registered literal`);
}

const rows = activityDb
  .prepare(
    `SELECT x.id, b.bytes
       FROM raw_exchange x JOIN raw_blob b ON b.hash = x.hash
      WHERE x.member_name = ? AND x.kind = 'request'
      ORDER BY x.id DESC LIMIT 2000`,
  )
  .all(memberName);

let matched = wireRequest
  ? { id: null, body: JSON.parse(readFileSync(wireRequest, 'utf8')) }
  : null;
for (const row of matched ? [] : rows) {
  let body;
  try {
    body = JSON.parse(gunzipSync(row.bytes).toString('utf8'));
  } catch {
    continue;
  }
  const instructionText =
    typeof body.instructions === 'string'
      ? body.instructions
      : typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('')
          : '';
  if (instructionText.includes(targetBlock)) {
    matched = { id: row.id, body };
    break;
  }
}
if (!matched)
  throw new Error(`no recent real request contains the current briefing for '${memberName}'`);

// The member name is a real registered literal in the #87 baseline. Compare
// the old mapping with the exemption-aware mapping against the same body.
registerSecretValues([registeredLiteral]);
try {
  const mapper = 'system' in matched.body ? anthropicToGenAi : openaiResponsesToGenAi;
  // Mirror the Claude inline-body boundary: OTLP parsing redacts the JSON
  // body attribute before the correlator content-addresses and parses it.
  const beforeBody = redactJson(matched.body);
  const afterBody = redactJson(matched.body);
  if ('system' in matched.body) {
    afterBody.system = redactJson(matched.body.system, { exemptions });
  } else if ('instructions' in matched.body) {
    afterBody.instructions = redactJson(matched.body.instructions, { exemptions });
  }
  const before = mapper({ requestBody: beforeBody, responseBody: {} });
  const after = mapper({
    requestBody: afterBody,
    responseBody: {},
    redactionExemptions: exemptions,
  });
  const beforeText = before.systemInstructions.map((part) => part.content ?? '').join('');
  const afterText = after.systemInstructions.map((part) => part.content ?? '').join('');
  const afterBlock = afterText.slice(
    afterText.indexOf(targetBlock),
    afterText.indexOf(targetBlock) + targetBlock.length,
  );
  const result = {
    source: wireRequest ?? 'activity-db',
    query: wireRequest
      ? null
      : "SELECT x.id,b.bytes FROM raw_exchange x JOIN raw_blob b ON b.hash=x.hash WHERE x.member_name=? AND x.kind='request' ORDER BY x.id DESC LIMIT 2000",
    member: memberName,
    rawExchangeId: matched.id,
    briefingBlockSha256: hash(targetBlock),
    capturedBlockSha256: hash(afterBlock),
    hashesMatch: hash(targetBlock) === hash(afterBlock),
    beforeRegisteredLiteralCount: beforeText.split(registeredLiteral).length - 1,
    afterRegisteredLiteralCount: afterText.split(registeredLiteral).length - 1,
    outsideBlockRedactionCoveredBy: 'core mapper same-request tests',
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.hashesMatch || result.afterRegisteredLiteralCount === 0) process.exitCode = 1;
} finally {
  clearRegisteredSecretValues();
}
