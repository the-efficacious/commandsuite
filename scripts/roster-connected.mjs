#!/usr/bin/env node

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

const member = process.argv[2];
if (!member) {
  process.stderr.write('usage: roster-connected.mjs <member>\n');
  process.exit(2);
}

try {
  const roster = JSON.parse(raw);
  const connected =
    Array.isArray(roster.connected) &&
    roster.connected.some(
      (entry) =>
        entry?.name === member && Number.isInteger(entry.connected) && entry.connected >= 1,
    );
  process.exit(connected ? 0 : 1);
} catch (error) {
  process.stderr.write(
    `invalid roster response: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
