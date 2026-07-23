import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconButton } from '../src/renderer/components/IconButton';

describe('IconButton accessibility', () => {
  it('emits an explicit false state only for toggle buttons', () => {
    const inactiveToggle = renderToStaticMarkup(
      createElement(IconButton, { label: '收藏夹', active: false, children: '收藏' }),
    );
    const activeToggle = renderToStaticMarkup(
      createElement(IconButton, { label: '收藏夹', active: true, children: '收藏' }),
    );
    const command = renderToStaticMarkup(
      createElement(IconButton, { label: '后退', children: '后退' }),
    );

    expect(inactiveToggle).toContain('aria-pressed="false"');
    expect(activeToggle).toContain('aria-pressed="true"');
    expect(command).not.toContain('aria-pressed');
  });
});
