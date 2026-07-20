/**
 * Renders of MessageAttachments — verifies image inline (button that
 * opens the global preview modal), non-image chip (preview button +
 * adjacent download icon), and ordering. Size rendering is a sanity-
 * check so the sidebar copy stays consistent with what the wire ships.
 */

import { render } from '@testing-library/preact';
import type { Attachment } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageAttachments } from '../src/components/MessageAttachments.js';
import { __resetPreviewForTests } from '../src/lib/file-preview.js';

const img: Attachment = {
  path: '/alice/uploads/photo.png',
  name: 'photo.png',
  size: 2048,
  mimeType: 'image/png',
};

const doc: Attachment = {
  path: '/alice/uploads/report.pdf',
  name: 'report.pdf',
  size: 1024 * 1024 * 2,
  mimeType: 'application/pdf',
};

describe('MessageAttachments', () => {
  afterEach(() => {
    __resetPreviewForTests();
  });

  it('returns nothing for an empty attachments array', () => {
    const { container } = render(<MessageAttachments attachments={[]} />);
    expect(container.textContent).toBe('');
  });

  it('renders images as a click-to-preview button with the inline thumbnail', () => {
    const { container } = render(<MessageAttachments attachments={[img]} />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('/fs/read/alice/uploads/photo.png');
    expect(image?.getAttribute('alt')).toBe('photo.png');
    // Image now lives inside a button that opens the preview modal
    // rather than an anchor that navigates to /fs/read directly.
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.contains(image)).toBe(true);
  });

  it('renders non-images as a preview chip plus a download anchor', () => {
    const { container } = render(<MessageAttachments attachments={[doc]} />);
    // The chip itself is a button (preview); the small icon next to
    // it is an <a download> hitting /fs/read.
    const chipButton = container.querySelector('button');
    expect(chipButton).not.toBeNull();
    expect(chipButton?.getAttribute('title')).toBe('Preview report.pdf');
    const downloadLink = container.querySelector('a');
    expect(downloadLink).not.toBeNull();
    expect(downloadLink?.getAttribute('href')).toBe('/fs/read/alice/uploads/report.pdf');
    expect(downloadLink?.getAttribute('download')).toBe('report.pdf');
    expect(container.textContent).toContain('report.pdf');
    expect(container.textContent).toContain('2.0 MB');
  });

  it('renders a mix in order', () => {
    const { container } = render(<MessageAttachments attachments={[doc, img]} />);
    // Top-level entries: doc chip (button + a) then image (button).
    // Both are buttons; only the doc chip emits a download anchor.
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('title')).toBe('Preview report.pdf');
    const image = buttons[1]?.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/fs/read/alice/uploads/photo.png');
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('href')).toBe('/fs/read/alice/uploads/report.pdf');
  });
});
