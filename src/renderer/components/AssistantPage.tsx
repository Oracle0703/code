import {
  AlertTriangle,
  Check,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Save,
  Send,
  Settings2,
  Sparkles,
  Square,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  AssistantContextReference,
  AssistantCredentialStatus,
  AssistantPhase,
  AssistantSnapshot,
  Note,
  Task,
} from '../../shared/contracts';
import { MarkdownPreview } from './MarkdownPreview';

export type AssistantContextDraft = AssistantContextReference;

interface AssistantPageProps {
  readonly workspaceName: string;
  readonly credential: AssistantCredentialStatus | null;
  readonly credentialStatus: 'loading' | 'ready' | 'error';
  readonly credentialError: string | null;
  readonly runtimeStatus: 'loading' | 'ready' | 'error';
  readonly runtimeError: string | null;
  readonly runtime: AssistantSnapshot | null;
  readonly operation: 'start' | 'cancel' | null;
  readonly notes: readonly Note[];
  readonly tasks: readonly Task[];
  readonly initialContext: AssistantContextDraft;
  readonly contextGeneration: number;
  readonly promptMaxLength: number;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
  readonly onStart: (prompt: string, context: AssistantContextDraft) => Promise<void>;
  readonly onCancel: (runId: string) => Promise<void>;
  readonly onSaveResponse: (response: string) => Promise<void>;
}

export function AssistantPage({
  workspaceName,
  credential,
  credentialStatus,
  credentialError,
  runtimeStatus,
  runtimeError,
  runtime,
  operation,
  notes,
  tasks,
  initialContext,
  contextGeneration,
  promptMaxLength,
  onRetry,
  onOpenSettings,
  onStart,
  onCancel,
  onSaveResponse,
}: AssistantPageProps) {
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState<AssistantContextDraft>(initialContext);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [savedResponseKey, setSavedResponseKey] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const contextGenerationRef = useRef(contextGeneration);
  const previousPhaseRef = useRef<AssistantPhase | null>(runtime?.phase ?? null);
  const promptLength = Array.from(prompt.trim()).length;
  const promptTooLong = promptLength > promptMaxLength;
  const running = runtime?.phase === 'running';
  const responseKey = runtime
    ? `${runtime.workspaceId}:${runtime.runId ?? `sequence-${runtime.sequence}`}`
    : null;
  const responseSaved = responseKey !== null && savedResponseKey === responseKey;
  const configured =
    credentialStatus === 'ready' &&
    credential?.availability === 'available' &&
    credential.configured;
  const effectiveContext = useMemo<AssistantContextDraft>(
    () =>
      context.kind === 'note' &&
      !notes.some(({ id, revision }) => id === context.noteId && revision === context.revision)
        ? { kind: 'none' }
        : context,
    [context, notes],
  );
  const entryNote = useMemo(
    () =>
      initialContext.kind === 'note'
        ? (notes.find(
            ({ id, revision }) =>
              id === initialContext.noteId && revision === initialContext.revision,
          ) ?? null)
        : null,
    [initialContext, notes],
  );
  const taskContextOption =
    initialContext.kind === 'tasks'
      ? initialContext
      : effectiveContext.kind === 'tasks'
        ? effectiveContext
        : null;
  const contextOptions = [
    { value: 'none', label: '仅发送问题' },
    { value: 'today', label: '今日任务与日程' },
    ...(entryNote
      ? [
          {
            value: `note:${entryNote.id}:${entryNote.revision}`,
            label: `笔记：${entryNote.title}`,
          },
        ]
      : []),
    ...(taskContextOption
      ? [
          {
            value: encodeContext(taskContextOption),
            label: `已选 ${taskContextOption.taskIds.length} 项任务`,
          },
        ]
      : []),
  ];

  useEffect(() => {
    contextGenerationRef.current = contextGeneration;
    queueMicrotask(() => {
      if (contextGenerationRef.current !== contextGeneration) return;
      setContext(initialContext);
      setSubmitError(null);
      setSaveFeedback(null);
    });
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, [contextGeneration, initialContext]);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    const nextPhase = runtime?.phase ?? null;
    previousPhaseRef.current = nextPhase;
    if (previousPhase === 'running' && nextPhase === 'cancelled') {
      window.requestAnimationFrame(() => promptRef.current?.focus());
    }
  }, [runtime?.phase]);

  const selectedContext = encodeContext(effectiveContext);
  const contextDescription = describeContext(effectiveContext, notes, tasks);
  const canSubmit =
    configured &&
    runtimeStatus === 'ready' &&
    !running &&
    operation === null &&
    promptLength > 0 &&
    !promptTooLong;

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    setSaveFeedback(null);
    try {
      await onStart(prompt.trim(), effectiveContext);
      setPrompt('');
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '问题未能发送，请重试。');
      window.requestAnimationFrame(() => promptRef.current?.focus());
    }
  };

  const cancel = async () => {
    if (!running || !runtime?.runId || operation !== null) return;
    setSubmitError(null);
    try {
      await onCancel(runtime.runId);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '未能停止本次回答，请重试。');
    } finally {
      window.requestAnimationFrame(() => promptRef.current?.focus());
    }
  };

  const saveResponse = async () => {
    if (
      runtime?.phase !== 'completed' ||
      !runtime.response.trim() ||
      saving ||
      responseSaved ||
      !responseKey
    ) {
      return;
    }
    setSaving(true);
    setSaveFeedback(null);
    try {
      await onSaveResponse(runtime.response);
      setSavedResponseKey(responseKey);
      setSaveFeedback('回答已保存为当前工作区的新笔记。');
    } catch (error) {
      setSaveFeedback(error instanceof Error ? error.message : '回答未能保存，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="section-page assistant-page">
      <header className="section-page__header assistant-page__header">
        <div className="section-page__title">
          <span>
            <MessageSquareText size={20} aria-hidden="true" />
          </span>
          <div>
            <h1 ref={headingRef} tabIndex={-1}>
              AI 助手
            </h1>
            <p>只使用你为这次问题明确选择的工作区上下文。</p>
          </div>
        </div>
        <span className={`assistant-provider${configured ? ' is-ready' : ''}`}>
          <Sparkles size={14} aria-hidden="true" />
          {credential?.provider ?? 'OpenAI'} · {credential?.model ?? '固定模型'}
        </span>
      </header>

      {credentialStatus === 'loading' || runtimeStatus === 'loading' ? (
        <section className="assistant-page-state" role="status" aria-busy="true">
          <LoaderCircle className="is-spinning" size={24} aria-hidden="true" />
          <h2>正在准备 AI 助手</h2>
          <p>正在检查安全凭据与当前工作区会话。</p>
        </section>
      ) : credentialStatus === 'error' || runtimeStatus === 'error' ? (
        <section className="assistant-page-state is-error" role="alert">
          <AlertTriangle size={24} aria-hidden="true" />
          <h2>AI 助手暂时不可用</h2>
          <p>{credentialError ?? runtimeError ?? '请稍后重试。'}</p>
          <button type="button" className="secondary-button" onClick={onRetry}>
            重新检查
          </button>
        </section>
      ) : credential?.availability === 'unavailable' ? (
        <section className="assistant-page-state is-error" role="alert">
          <AlertTriangle size={24} aria-hidden="true" />
          <h2>
            {credential.reason === 'plaintext-storage'
              ? '系统只提供明文凭据后端'
              : '系统安全存储不可用'}
          </h2>
          <p>
            {credential.reason === 'plaintext-storage'
              ? '请启用操作系统密钥环后重新启动应用；AI 助手拒绝降级保存明文密钥。'
              : 'AI 助手保持停用，不会把密钥保存到明文文件。'}
          </p>
          <button type="button" className="secondary-button" onClick={onOpenSettings}>
            <Settings2 size={14} aria-hidden="true" /> 查看 AI 设置
          </button>
        </section>
      ) : credential?.reason === 'credential-corrupt' ? (
        <section className="assistant-page-state is-error" role="alert">
          <AlertTriangle size={24} aria-hidden="true" />
          <h2>已保存的 API 密钥无法解密</h2>
          <p>请在 AI 设置中替换或移除这份损坏的凭据。</p>
          <button type="button" className="secondary-button" onClick={onOpenSettings}>
            <Settings2 size={14} aria-hidden="true" /> 打开 AI 设置
          </button>
        </section>
      ) : !credential?.configured ? (
        <section className="assistant-page-state">
          <MessageSquareText size={24} aria-hidden="true" />
          <h2>连接 OpenAI 后开始</h2>
          <p>请先在设置中安全保存自己的 OpenAI API 密钥。</p>
          <button type="button" className="primary-button" onClick={onOpenSettings}>
            <Settings2 size={14} aria-hidden="true" /> 配置 AI 助手
          </button>
        </section>
      ) : (
        <div className="assistant-workspace">
          <section className="assistant-compose" aria-label="新问题">
            <div className="assistant-context">
              <label htmlFor="assistant-context">本次上下文</label>
              <select
                id="assistant-context"
                value={selectedContext}
                disabled={running || operation !== null}
                onChange={(event) =>
                  setContext(
                    decodeContext(event.target.value, notes, effectiveContext, taskContextOption),
                  )
                }
              >
                {contextOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p>
                <FileText size={13} aria-hidden="true" />
                {contextDescription}
              </p>
            </div>

            <form onSubmit={(event) => void submit(event)}>
              <label htmlFor="assistant-prompt">你的问题</label>
              <textarea
                id="assistant-prompt"
                ref={promptRef}
                value={prompt}
                rows={5}
                disabled={running || operation !== null}
                aria-invalid={promptTooLong}
                aria-describedby="assistant-prompt-help assistant-prompt-count"
                placeholder={`询问 ${workspaceName} 中需要梳理的问题…`}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.ctrlKey || event.metaKey) &&
                    !event.altKey &&
                    !event.shiftKey &&
                    !event.repeat &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="assistant-compose__footer">
                <span id="assistant-prompt-help">
                  Ctrl / ⌘ + Enter 发送；发送前不会自动读取数据。
                </span>
                <span id="assistant-prompt-count" className={promptTooLong ? 'is-error' : ''}>
                  {promptLength} / {promptMaxLength}
                </span>
                {running ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={operation !== null}
                    onClick={() => void cancel()}
                  >
                    {operation === 'cancel' ? (
                      <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                    ) : (
                      <Square size={13} aria-hidden="true" />
                    )}
                    {operation === 'cancel' ? '停止中…' : '停止回答'}
                  </button>
                ) : (
                  <button type="submit" className="primary-button" disabled={!canSubmit}>
                    {operation === 'start' ? (
                      <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                    ) : (
                      <Send size={14} aria-hidden="true" />
                    )}
                    {operation === 'start' ? '发送中…' : '发送'}
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="assistant-response" role="log" aria-label="AI 回答记录">
            <header>
              <div>
                <span className={`assistant-response__state is-${runtime?.phase ?? 'idle'}`}>
                  {runtime?.phase === 'running' ? (
                    <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                  ) : runtime?.phase === 'completed' ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <MessageSquareText size={14} aria-hidden="true" />
                  )}
                  {phaseLabel(runtime?.phase ?? 'idle')}
                </span>
                {runtime?.contextSummary ? (
                  <small>
                    {runtime.contextSummary.label}
                    {runtime.contextSummary.totalCount > 0
                      ? ` · 已包含 ${runtime.contextSummary.includedCount} / ${runtime.contextSummary.totalCount} ${runtime.contextSummary.kind === 'note' ? '字符' : '项'}`
                      : ''}
                    {runtime.contextSummary.truncated ? ' · 已按安全上限截断' : ''}
                  </small>
                ) : runtime?.context ? (
                  <small>{describeContext(runtime.context, notes, tasks)}</small>
                ) : null}
              </div>
              {runtime?.phase === 'completed' && runtime.response.trim() ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || responseSaved}
                  onClick={() => void saveResponse()}
                >
                  {responseSaved ? (
                    <Check size={14} aria-hidden="true" />
                  ) : saving ? (
                    <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                  ) : (
                    <Save size={14} aria-hidden="true" />
                  )}
                  {responseSaved ? '已保存' : saving ? '保存中…' : '保存为笔记'}
                </button>
              ) : null}
            </header>

            {runtime?.prompt ? (
              <div className="assistant-response__prompt">
                <small>你的问题</small>
                <p>{runtime.prompt}</p>
              </div>
            ) : null}

            {runtime?.response ? (
              <div className="assistant-response__markdown">
                <MarkdownPreview source={runtime.response} />
              </div>
            ) : (
              <div className="assistant-response__empty">
                <MessageSquareText size={24} aria-hidden="true" />
                <p>{running ? '正在等待第一段回答…' : '发送问题后，回答会显示在这里。'}</p>
              </div>
            )}

            {runtime?.phase === 'failed' && runtime.error ? (
              <p className="assistant-response__error" role="alert">
                {runtime.error.message}
                {runtime.response ? ' 已生成的部分回答仍保留在上方。' : ''}
              </p>
            ) : null}
            {runtime?.contextSummary?.truncated ? (
              <p className="assistant-response__notice" role="status">
                上下文超过安全上限；本次回答仅使用了上方标明的部分记录。
              </p>
            ) : null}
            {runtime?.phase === 'cancelled' ? (
              <p className="assistant-response__notice" role="status">
                回答已停止。{runtime.response ? '已生成的部分回答仍保留在上方。' : ''}
              </p>
            ) : null}
            {saveFeedback ? (
              <p
                className="assistant-response__notice"
                role={saveFeedback.includes('未能') ? 'alert' : 'status'}
              >
                {saveFeedback}
              </p>
            ) : null}
          </section>
        </div>
      )}

      {submitError ? (
        <p className="assistant-page__operation-error" role="alert">
          {submitError}
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {operation === 'cancel'
          ? '正在停止回答。'
          : running
            ? 'AI 正在生成回答。'
            : runtime?.phase === 'completed'
              ? 'AI 回答已完成。'
              : ''}
      </p>
    </div>
  );
}

function encodeContext(context: AssistantContextDraft): string {
  switch (context.kind) {
    case 'none':
    case 'today':
      return context.kind;
    case 'tasks':
      return `tasks:${context.taskIds.join(',')}`;
    case 'note':
      return `note:${context.noteId}:${context.revision}`;
  }
}

function decodeContext(
  value: string,
  notes: readonly Note[],
  current: AssistantContextDraft,
  taskContextOption: Extract<AssistantContextDraft, { readonly kind: 'tasks' }> | null,
): AssistantContextDraft {
  if (value === 'today') return { kind: 'today' };
  if (value.startsWith('tasks:')) {
    if (current.kind === 'tasks' && value === encodeContext(current)) return current;
    if (taskContextOption && value === encodeContext(taskContextOption)) return taskContextOption;
  }
  if (value.startsWith('note:')) {
    const note = notes.find(({ id, revision }) => value === `note:${id}:${revision}`);
    if (note) return { kind: 'note', noteId: note.id, revision: note.revision };
  }
  return { kind: 'none' };
}

function describeContext(
  context: AssistantContextDraft,
  notes: readonly Note[],
  tasks: readonly Task[] = [],
): string {
  switch (context.kind) {
    case 'none':
      return '只发送你输入的问题，不附带工作区记录。';
    case 'today':
      return '发送当前工作区的名称、今日未完成任务与今日日程。';
    case 'tasks':
      return `发送你明确选择的 ${context.taskIds.length} 项未完成任务：${
        context.taskIds
          .map((taskId) => tasks.find(({ id }) => id === taskId)?.title)
          .filter((title): title is string => Boolean(title))
          .join('、') || '任务标题将在发送时重新校验'
      }。`;
    case 'note': {
      const note = notes.find(
        ({ id, revision }) => id === context.noteId && revision === context.revision,
      );
      return note ? `发送已保存笔记“${note.title}”的标题与正文。` : '所选笔记已变化，请重新选择。';
    }
  }
}

function phaseLabel(phase: AssistantPhase): string {
  switch (phase) {
    case 'idle':
      return '尚未提问';
    case 'running':
      return '正在生成';
    case 'completed':
      return '回答完成';
    case 'failed':
      return '回答失败';
    case 'cancelled':
      return '已停止';
  }
}
