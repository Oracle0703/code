import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '../src/renderer/components/MarkdownPreview';
import { safeMarkdownLink } from '../src/renderer/markdown-state';

describe('safe Markdown preview', () => {
  it('renders common Markdown as React elements without injecting source HTML', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        source:
          '# 标题\n\n- **粗体**\n- `代码`\n\n<script>alert(1)</script>\n\n```ts\nconst ok = true;\n```',
      }),
    );

    expect(markup).toContain('<h1>标题</h1>');
    expect(markup).toContain('<ul>');
    expect(markup).toContain('<strong>粗体</strong>');
    expect(markup).toContain('<code>代码</code>');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('data-language="ts"');
  });

  it('turns approved web links into controlled buttons and blocks active URL schemes', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        source:
          '[安全链接](https://example.com/path) [脚本链接](javascript:alert%281%29) ![远程图](https://example.com/a.png)',
        onOpenLink: () => undefined,
      }),
    );

    expect(markup).toContain(
      '<button type="button" class="markdown-preview__link">安全链接</button>',
    );
    expect(markup).toContain('<span class="markdown-preview__blocked-link">脚本链接</span>');
    expect(markup).toContain('图片：远程图');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('javascript:');
  });

  it('accepts only absolute HTTP and HTTPS destinations', () => {
    expect(safeMarkdownLink('https://example.com/path')).toBe('https://example.com/path');
    expect(safeMarkdownLink('http://example.com')).toBe('http://example.com/');
    expect(safeMarkdownLink('/relative')).toBeNull();
    expect(safeMarkdownLink('file:///tmp/private')).toBeNull();
    expect(safeMarkdownLink('javascript:alert(1)')).toBeNull();
  });
});
