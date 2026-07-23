import {
  Archive,
  Check,
  FileText,
  LoaderCircle,
  NotebookPen,
  PencilLine,
  Plus,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Note } from '../../shared/contracts';
import { NOTE_BODY_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH } from '../../shared/note-domain';
import { filterNotes, isNoteDraftDirty, noteExcerpt } from '../note-state';
import { MarkdownPreview } from './MarkdownPreview';

interface NoteEditorState {
  readonly key: string;
  readonly note: Note | null;
  readonly title: string;
  readonly body: string;
}

type NoteSelection =
  { readonly kind: 'note'; readonly noteId: string } | { readonly kind: 'new' } | null;

interface NotePageProps {
  workspaceName: string;
  notes: readonly Note[];
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  operationError: string | null;
  pendingNoteIds: ReadonlySet<string>;
  pendingCreate: boolean;
  requestedNoteId: string | null;
  onRequestedNoteHandled: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onRetry: () => void;
  onCreate: (title: string, body: string) => Promise<Note>;
  onUpdate: (note: Note, title: string, body: string) => Promise<Note>;
  onArchive: (note: Note) => Promise<void>;
  onOpenLink: (url: string) => void;
}

export function NotePage({
  workspaceName,
  notes,
  status,
  loadError,
  operationError,
  pendingNoteIds,
  pendingCreate,
  requestedNoteId,
  onRequestedNoteHandled,
  onDirtyChange,
  onRetry,
  onCreate,
  onUpdate,
  onArchive,
  onOpenLink,
}: NotePageProps) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<NoteSelection>(null);
  const [draft, setDraft] = useState<NoteEditorState | null>(null);
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('edit');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const visibleNotes = useMemo(() => filterNotes(notes, query), [notes, query]);
  const editor = useMemo<NoteEditorState | null>(() => {
    const requestedNote = requestedNoteId
      ? (notes.find(({ id }) => id === requestedNoteId) ?? null)
      : null;
    const selectedNote =
      selection?.kind === 'note' ? (notes.find(({ id }) => id === selection.noteId) ?? null) : null;
    const activeNote =
      requestedNote ?? selectedNote ?? (selection?.kind === 'new' ? null : (notes[0] ?? null));
    const editorKey = selection?.kind === 'new' ? 'new' : (activeNote?.id ?? null);
    const matchingDraft = editorKey !== null && draft?.key === editorKey ? draft : null;
    const matchingDraftDirty = matchingDraft
      ? isNoteDraftDirty(matchingDraft.note, matchingDraft.title, matchingDraft.body)
      : false;
    const useMatchingDraft =
      matchingDraft !== null &&
      (matchingDraftDirty ||
        matchingDraft.note === null ||
        matchingDraft.note.revision === activeNote?.revision);
    if (!editorKey) return null;
    if (useMatchingDraft) return matchingDraft;
    if (activeNote) {
      return {
        key: activeNote.id,
        note: activeNote,
        title: activeNote.title,
        body: activeNote.body,
      };
    }
    return { key: 'new', note: null, title: '', body: '' };
  }, [draft, notes, requestedNoteId, selection]);
  const dirty = editor ? isNoteDraftDirty(editor.note, editor.title, editor.body) : false;
  const titleLength = Array.from(editor?.title.trim() ?? '').length;
  const bodyLength = Array.from(editor?.body ?? '').length;
  const titleInvalid = titleLength < 1 || titleLength > NOTE_TITLE_MAX_LENGTH;
  const bodyInvalid = bodyLength > NOTE_BODY_MAX_LENGTH;
  const saving = editor?.note ? pendingNoteIds.has(editor.note.id) : pendingCreate;

  const confirmDiscard = useCallback(
    () => !dirty || window.confirm('这篇笔记有尚未保存的更改。要放弃这些更改并继续吗？'),
    [dirty],
  );

  const openNote = useCallback(
    (note: Note) => {
      if (!confirmDiscard()) return;
      onRequestedNoteHandled();
      setSelection({ kind: 'note', noteId: note.id });
      setDraft(null);
      setEditorMode('edit');
      setSaveError(null);
    },
    [confirmDiscard, onRequestedNoteHandled],
  );

  const openNew = useCallback(() => {
    if (!confirmDiscard()) return;
    onRequestedNoteHandled();
    setSelection({ kind: 'new' });
    setDraft(null);
    setEditorMode('edit');
    setSaveError(null);
    window.requestAnimationFrame(() => titleInputRef.current?.focus());
  }, [confirmDiscard, onRequestedNoteHandled]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  const save = useCallback(async () => {
    if (!editor || saving || titleInvalid || bodyInvalid) return;
    setSaveError(null);
    try {
      const saved = editor.note
        ? await onUpdate(editor.note, editor.title, editor.body)
        : await onCreate(editor.title, editor.body);
      onRequestedNoteHandled();
      setSelection({ kind: 'note', noteId: saved.id });
      setDraft(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '笔记保存失败，请重试。');
    }
  }, [bodyInvalid, editor, onCreate, onRequestedNoteHandled, onUpdate, saving, titleInvalid]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (
        !editor ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLocaleLowerCase() !== 's'
      ) {
        return;
      }
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [editor, save]);

  const archiveCurrent = async () => {
    const note = editor?.note;
    if (!note || saving || archiving) return;
    if (dirty && !confirmDiscard()) return;
    if (!window.confirm(`归档“${note.title}”？内容仍会保留在本地备份中。`)) return;
    setArchiving(true);
    setSaveError(null);
    try {
      await onArchive(note);
      onRequestedNoteHandled();
      setSelection(null);
      setDraft(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '笔记归档失败，请重试。');
    } finally {
      setArchiving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  return (
    <div className="section-page note-page" aria-busy={status === 'loading'}>
      <header className="section-page__header note-page__header">
        <div className="section-page__title">
          <span>
            <NotebookPen size={20} aria-hidden="true" />
          </span>
          <div>
            <h1 tabIndex={-1}>笔记</h1>
            <p>
              {status === 'ready' ? `${notes.length} 篇 Markdown 笔记` : '保存当前工作区的上下文。'}
            </p>
          </div>
        </div>
        <button type="button" className="primary-button" onClick={openNew} disabled={saving}>
          <Plus size={15} aria-hidden="true" /> 新建笔记
        </button>
      </header>

      {status === 'error' ? (
        <section className="note-state" role="alert">
          <NotebookPen size={24} />
          <h2>笔记暂时无法读取</h2>
          <p>{loadError ?? '请稍后重试。'}</p>
          <button type="button" className="secondary-button" onClick={onRetry}>
            重新加载
          </button>
        </section>
      ) : status === 'loading' ? (
        <section className="note-state" aria-live="polite">
          <LoaderCircle className="is-spinning" size={24} />
          <h2>正在读取笔记</h2>
          <p>正在从 {workspaceName} 的 SQLite 数据中加载笔记…</p>
        </section>
      ) : (
        <>
          {operationError ? (
            <p className="note-operation-error" role="alert">
              {operationError}
            </p>
          ) : null}
          <section className="note-workspace">
            <aside className="note-library" aria-label="笔记列表">
              <label className="note-library__search">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">搜索笔记标题和正文</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索标题和正文"
                />
              </label>
              <div className="note-library__meta">
                <span>{visibleNotes.length} 篇</span>
                {query ? (
                  <button type="button" onClick={() => setQuery('')}>
                    清除搜索
                  </button>
                ) : null}
              </div>
              <div className="note-library__list">
                {visibleNotes.map((note) => (
                  <button
                    type="button"
                    className={editor?.note?.id === note.id ? 'is-active' : ''}
                    key={note.id}
                    onClick={() => openNote(note)}
                  >
                    <span>
                      <FileText size={14} aria-hidden="true" />
                    </span>
                    <strong>{note.title}</strong>
                    <p>{noteExcerpt(note.body)}</p>
                    <time dateTime={note.updatedAt}>{formatUpdatedAt(note.updatedAt)}</time>
                  </button>
                ))}
                {visibleNotes.length === 0 ? (
                  <div className="note-library__empty">
                    <Search size={18} />
                    <span>{notes.length === 0 ? '还没有笔记' : '没有匹配的笔记'}</span>
                    {notes.length === 0 ? (
                      <button type="button" onClick={openNew}>
                        创建第一篇
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </aside>

            <div className="note-editor-shell">
              {editor ? (
                <form className="note-editor" onSubmit={submit}>
                  <header className="note-editor__toolbar">
                    <div className="segmented-control" role="tablist" aria-label="笔记编辑模式">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={editorMode === 'edit'}
                        className={editorMode === 'edit' ? 'is-active' : ''}
                        onClick={() => setEditorMode('edit')}
                      >
                        <PencilLine size={13} /> 编辑
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={editorMode === 'preview'}
                        className={editorMode === 'preview' ? 'is-active' : ''}
                        onClick={() => setEditorMode('preview')}
                      >
                        <FileText size={13} /> 预览
                      </button>
                    </div>
                    <span
                      className={`note-editor__status${saveError ? ' is-error' : ''}`}
                      role="status"
                    >
                      {saveError
                        ? '保存失败'
                        : saving
                          ? '保存中…'
                          : dirty
                            ? '未保存'
                            : editor.note
                              ? `已保存 · 修订 ${editor.note.revision}`
                              : '新笔记'}
                    </span>
                    {editor.note ? (
                      <button
                        type="button"
                        className="note-editor__archive"
                        onClick={() => void archiveCurrent()}
                        disabled={saving || archiving}
                      >
                        {archiving ? (
                          <LoaderCircle className="is-spinning" size={14} />
                        ) : (
                          <Archive size={14} />
                        )}
                        归档
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      className="note-editor__save"
                      disabled={!dirty || saving || titleInvalid || bodyInvalid}
                    >
                      {saving ? (
                        <LoaderCircle className="is-spinning" size={14} />
                      ) : (
                        <Check size={14} />
                      )}
                      {saving ? '保存中…' : '保存'}
                    </button>
                  </header>

                  <label className="note-editor__title">
                    <span className="sr-only">笔记标题</span>
                    <input
                      ref={titleInputRef}
                      value={editor.title}
                      onChange={(event) => setDraft({ ...editor, title: event.target.value })}
                      placeholder="笔记标题"
                      disabled={saving}
                      aria-invalid={titleInvalid}
                      aria-describedby="note-title-count"
                    />
                    <small id="note-title-count" className={titleInvalid ? 'is-error' : undefined}>
                      {titleLength} / {NOTE_TITLE_MAX_LENGTH}
                    </small>
                  </label>

                  {editorMode === 'edit' ? (
                    <label className="note-editor__body" role="tabpanel">
                      <span className="sr-only">Markdown 正文</span>
                      <textarea
                        value={editor.body}
                        onChange={(event) => setDraft({ ...editor, body: event.target.value })}
                        placeholder={'使用 Markdown 记录内容…\n\n# 标题\n- 清单\n- `代码`'}
                        disabled={saving}
                        aria-invalid={bodyInvalid}
                        aria-describedby="note-body-count"
                        spellCheck
                      />
                    </label>
                  ) : (
                    <div className="note-editor__preview" role="tabpanel">
                      <MarkdownPreview source={editor.body} onOpenLink={onOpenLink} />
                    </div>
                  )}

                  <footer>
                    <small id="note-body-count" className={bodyInvalid ? 'is-error' : undefined}>
                      {bodyLength.toLocaleString()} / {NOTE_BODY_MAX_LENGTH.toLocaleString()} 字符
                    </small>
                    <span>
                      <kbd>Ctrl S</kbd> 保存
                    </span>
                  </footer>
                  {saveError ? (
                    <p className="note-editor__error" role="alert">
                      {saveError}
                    </p>
                  ) : null}
                </form>
              ) : (
                <div className="note-editor-empty">
                  <NotebookPen size={25} />
                  <h2>{notes.length === 0 ? '创建第一篇笔记' : '选择一篇笔记'}</h2>
                  <p>在编辑与安全预览之间切换，确认后显式保存到当前工作区。</p>
                  <button type="button" className="secondary-button" onClick={openNew}>
                    <Plus size={14} /> 新建笔记
                  </button>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
