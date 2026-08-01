import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('enrollment instruction metrics', () => {
  it('wires both new-member prose fields to the shared readout', () => {
    const enrollment = readFileSync(join(process.cwd(), 'src/routes/Enroll.tsx'), 'utf8');

    expect(enrollment).toContain('<TextMetrics text={f.createDescription} />');
    expect(enrollment).toContain('<TextMetrics text={f.createInstructions} />');
  });
});
