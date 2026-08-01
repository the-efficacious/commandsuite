import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { TextMetrics } from '../src/components/ui/TextMetrics.js';

describe('instruction metrics authoring surfaces', () => {
  it('renders characters, labels tokens as estimated, and states the method', () => {
    render(<TextMetrics text="12345" />);
    expect(screen.getByText('5 characters · ≈2 estimated tokens (characters ÷ 4)')).toBeTruthy();
  });

  it('wires every web authoring field to the shared readout', () => {
    const team = readFileSync(join(process.cwd(), 'src/components/TeamHome.tsx'), 'utf8');
    const create = readFileSync(join(process.cwd(), 'src/components/MembersPanel.tsx'), 'utf8');
    const manage = readFileSync(
      join(process.cwd(), 'src/components/members/MemberAdminForm.tsx'),
      'utf8',
    );

    expect(team).toContain('<TextMetrics text={ctxDraft.value} />');
    expect(create).toContain('<TextMetrics text={formRoleDescription.value} />');
    expect(create).toContain('<TextMetrics text={formInstructions.value} />');
    expect(manage).toContain('<TextMetrics text={roleDescription} />');
    expect(manage).toContain('<TextMetrics text={instructions} />');
    expect(manage).not.toContain('maxLength={8192}');
  });
});
