import { describe, expect, it } from 'vitest';
import {
  parseAssistantCancelInput,
  parseAssistantCredentialInput,
  parseAssistantStartInput,
} from '../src/main/ipc/validation';
import {
  ASSISTANT_API_KEY_MAX_LENGTH,
  ASSISTANT_PROMPT_MAX_LENGTH,
  ASSISTANT_SELECTED_TASK_MAX_COUNT,
  normalizeAssistantContextReference,
  normalizeAssistantPrompt,
} from '../src/shared/assistant-domain';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_ID = '22222222-2222-4222-8222-222222222222';

describe('assistant domain and IPC validation', () => {
  it('normalizes bounded prompts without changing their internal text', () => {
    expect(normalizeAssistantPrompt('  第一行\r\n第二行  ')).toBe('第一行\n第二行');
    expect(normalizeAssistantPrompt('字'.repeat(ASSISTANT_PROMPT_MAX_LENGTH))).toHaveLength(
      ASSISTANT_PROMPT_MAX_LENGTH,
    );
    expect(() => normalizeAssistantPrompt('')).toThrow(TypeError);
    expect(() => normalizeAssistantPrompt(`问题\u0000`)).toThrow(TypeError);
    expect(() => normalizeAssistantPrompt('字'.repeat(ASSISTANT_PROMPT_MAX_LENGTH + 1))).toThrow(
      TypeError,
    );
  });

  it('accepts only exact no-content context references', () => {
    expect(normalizeAssistantContextReference({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(normalizeAssistantContextReference({ kind: 'today' })).toEqual({ kind: 'today' });
    expect(normalizeAssistantContextReference({ kind: 'tasks', taskIds: [TASK_ID] })).toEqual({
      kind: 'tasks',
      taskIds: [TASK_ID],
    });
    expect(
      normalizeAssistantContextReference({ kind: 'note', noteId: NOTE_ID, revision: 2 }),
    ).toEqual({ kind: 'note', noteId: NOTE_ID, revision: 2 });

    expect(() =>
      normalizeAssistantContextReference({ kind: 'note', noteId: NOTE_ID, revision: 2, body: 'x' }),
    ).toThrow(TypeError);
    expect(() =>
      normalizeAssistantContextReference({ kind: 'tasks', taskIds: [TASK_ID, TASK_ID] }),
    ).toThrow(TypeError);
    expect(() =>
      normalizeAssistantContextReference({
        kind: 'tasks',
        taskIds: Array.from(
          { length: ASSISTANT_SELECTED_TASK_MAX_COUNT + 1 },
          (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        ),
      }),
    ).toThrow(TypeError);
  });

  it('rejects renderer attempts to choose workspace, endpoint, model, tools, or raw context', () => {
    const valid = { prompt: '问题', context: { kind: 'none' } };
    expect(parseAssistantStartInput(valid)).toEqual(valid);
    for (const forged of [
      { ...valid, workspaceId: TASK_ID },
      { ...valid, endpoint: 'https://example.com/' },
      { ...valid, model: 'other' },
      { ...valid, tools: [{ type: 'shell' }] },
      { prompt: '问题', context: { kind: 'today', raw: 'secret' } },
    ]) {
      expect(() => parseAssistantStartInput(forged)).toThrow(TypeError);
    }
  });

  it('validates credentials and Main-generated run ids without echoing values in errors', () => {
    const apiKey = `sk-proj-${'a'.repeat(48)}`;
    expect(parseAssistantCredentialInput({ apiKey })).toEqual({ apiKey });
    expect(() =>
      parseAssistantCredentialInput({ apiKey: `sk-${'a'.repeat(ASSISTANT_API_KEY_MAX_LENGTH)}` }),
    ).toThrow('OpenAI API key format is invalid');
    expect(() => parseAssistantCredentialInput({ apiKey: ` ${apiKey}` })).toThrow(TypeError);
    expect(parseAssistantCancelInput({ runId: TASK_ID })).toEqual({ runId: TASK_ID });
    expect(() => parseAssistantCancelInput({ runId: TASK_ID, workspaceId: NOTE_ID })).toThrow(
      TypeError,
    );
  });
});
