import { describe, expect, it } from 'vitest';
import {
  deriveNoteTitle,
  normalizeNoteBody,
  normalizeNoteId,
  normalizeNoteRevision,
  normalizeNoteTitle,
  NOTE_BODY_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
} from '../src/shared/note-domain';

describe('note domain', () => {
  it('preserves Markdown and canonicalizes line endings without trimming the body', () => {
    expect(normalizeNoteBody(' # 标题\r\n\r\n\t`code`\r尾部 ')).toBe(' # 标题\n\n\t`code`\n尾部 ');
    expect(normalizeNoteBody('')).toBe('');
  });

  it('validates titles by Unicode code point and keeps technical text intact', () => {
    expect(normalizeNoteTitle('  API e\u0301 👩‍💻  ')).toBe('API e\u0301 👩‍💻');
    expect(normalizeNoteTitle('🙂'.repeat(NOTE_TITLE_MAX_LENGTH))).toHaveLength(
      NOTE_TITLE_MAX_LENGTH * 2,
    );
    expect(() => normalizeNoteTitle('x\nsecond line')).toThrow(TypeError);
    expect(() => normalizeNoteTitle(' \u200b ')).toThrow(TypeError);
  });

  it('rejects malformed Unicode, unsupported controls, and oversized bodies', () => {
    expect(() => normalizeNoteBody('bad\0body')).toThrow(TypeError);
    expect(() => normalizeNoteBody('bad\u0085body')).toThrow(TypeError);
    expect(() => normalizeNoteBody('bad\u2028body')).toThrow(TypeError);
    expect(() => normalizeNoteBody('\ud800')).toThrow(TypeError);
    expect(() => normalizeNoteBody('🙂'.repeat(NOTE_BODY_MAX_LENGTH + 1))).toThrow(TypeError);
  });

  it('requires lowercase UUID v4 ids and positive safe revisions', () => {
    expect(normalizeNoteId('123e4567-e89b-42d3-a456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(() => normalizeNoteId('123E4567-E89B-42D3-A456-426614174000')).toThrow(TypeError);
    expect(normalizeNoteRevision(1)).toBe(1);
    expect(() => normalizeNoteRevision(0)).toThrow(TypeError);
    expect(() => normalizeNoteRevision(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });

  it('derives a bounded visible title from the first Markdown content line', () => {
    expect(deriveNoteTitle('\n# 产品方向\n\n正文')).toBe('产品方向');
    expect(deriveNoteTitle('')).toBe('无标题笔记');
    expect(deriveNoteTitle('x'.repeat(NOTE_TITLE_MAX_LENGTH + 20))).toBe(
      'x'.repeat(NOTE_TITLE_MAX_LENGTH),
    );
  });
});
