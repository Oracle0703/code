import { Fragment, type ReactNode } from 'react';
import { safeMarkdownLink } from '../markdown-state';

interface MarkdownPreviewProps {
  source: string;
  onOpenLink?: (url: string) => void;
}

export function MarkdownPreview({ source, onOpenLink }: MarkdownPreviewProps) {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s{0,3}```([\w-]*)\s*$/u.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/u.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="markdown-preview__code" key={`code-${index}`}>
          <code data-language={fence[1] || undefined}>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], onOpenLink, `heading-${index}`);
      if (level === 1) blocks.push(<h1 key={`heading-${index}`}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`heading-${index}`}>{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={`heading-${index}`}>{content}</h3>);
      else if (level === 4) blocks.push(<h4 key={`heading-${index}`}>{content}</h4>);
      else if (level === 5) blocks.push(<h5 key={`heading-${index}`}>{content}</h5>);
      else blocks.push(<h6 key={`heading-${index}`}>{content}</h6>);
      index += 1;
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/u.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/u.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/u, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {quoteLines.map((quoteLine, quoteIndex) => (
            <Fragment key={`quote-line-${quoteIndex}`}>
              {quoteIndex > 0 ? <br /> : null}
              {renderInlineMarkdown(quoteLine, onOpenLink, `quote-${quoteIndex}`)}
            </Fragment>
          ))}
        </blockquote>,
      );
      continue;
    }

    const unordered = /^\s{0,3}[-*+]\s+(.+)$/u.exec(line);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s{0,3}[-*+]\s+(.+)$/u.exec(lines[index] ?? '');
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>
              {renderInlineMarkdown(item, onOpenLink, `list-${itemIndex}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    const ordered = /^\s{0,3}\d+[.)]\s+(.+)$/u.exec(line);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s{0,3}\d+[.)]\s+(.+)$/u.exec(lines[index] ?? '');
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol key={`ordered-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>
              {renderInlineMarkdown(item, onOpenLink, `ordered-${itemIndex}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines[index] ?? '')) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {paragraph.map((paragraphLine, paragraphIndex) => (
          <Fragment key={`paragraph-line-${paragraphIndex}`}>
            {paragraphIndex > 0 ? <br /> : null}
            {renderInlineMarkdown(
              paragraphLine,
              onOpenLink,
              `paragraph-${index}-${paragraphIndex}`,
            )}
          </Fragment>
        ))}
      </p>,
    );
  }

  return (
    <article className="markdown-preview" aria-label="Markdown 预览">
      {blocks.length > 0 ? (
        blocks
      ) : (
        <p className="markdown-preview__empty">开始输入 Markdown 后，可在这里检查排版。</p>
      )}
    </article>
  );
}

function isBlockStart(line: string): boolean {
  return (
    !line.trim() ||
    /^\s{0,3}(?:```|#{1,6}\s|>\s?|[-*+]\s+|\d+[.)]\s+)/u.test(line) ||
    /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)
  );
}

function renderInlineMarkdown(
  value: string,
  onOpenLink: ((url: string) => void) | undefined,
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern =
    /(!?\[[^\]\n]*\]\([^\s)\n]+(?:\s+"[^"\n]*")?\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/gu;
  let cursor = 0;
  let tokenIndex = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const offset = match.index;
    if (offset > cursor) nodes.push(value.slice(cursor, offset));
    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex++}`;
    if (token.startsWith('![')) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/u.exec(token);
      nodes.push(
        <span className="markdown-preview__image-placeholder" key={key}>
          {image?.[1] ? `图片：${image[1]}` : '图片已隐藏'}
        </span>,
      );
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/u.exec(token);
      const safeUrl = link ? safeMarkdownLink(link[2]) : null;
      nodes.push(
        safeUrl && onOpenLink ? (
          <button
            type="button"
            className="markdown-preview__link"
            key={key}
            onClick={() => onOpenLink(safeUrl)}
          >
            {link?.[1]}
          </button>
        ) : (
          <span className="markdown-preview__blocked-link" key={key}>
            {link?.[1] ?? token}
          </span>
        ),
      );
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = offset + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}
