import {
  Archive,
  Check,
  FileText,
  LoaderCircle,
  MessageSquareText,
  NotebookPen,
  PencilLine,
  Plus,
  Search,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { Note, NoteCreateResult } from '../../shared/contracts';
import { NOTE_BODY_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH } from '../../shared/note-domain';
import type {
  NoteArchiveCommit,
  NoteCreateCommit,
  NoteMutationRecovery,
  NoteUpdateCommit,
} from '../hooks/useNoteController';
import {
  filterNotes,
  isNoteDraftDirty,
  noteExcerpt,
  type NoteCreateSyncWarningTarget,
  type NoteMutationSyncWarningTarget,
} from '../note-state';
import { MarkdownPreview } from './MarkdownPreview';
import { NoteCreateSyncWarning } from './NoteCreateSyncWarning';
import { NoteMutationSyncWarning } from './NoteMutationSyncWarning';

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
  pendingMutation: boolean;
  pendingMutationMessage?: string | null;
  requestedNoteId: string | null;
  onRequestedNoteHandled: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onRetry: () => void;
  onCreate: (title: string, body: string) => Promise<NoteCreateCommit>;
  createSyncWarning: NoteCreateSyncWarningTarget | null;
  onCreateSyncWarning: (warning: NoteCreateSyncWarningTarget) => void;
  onCreateSyncResolved: (warning: NoteCreateSyncWarningTarget) => void;
  onRefreshCreated: (result: NoteCreateResult) => Promise<Note | null>;
  mutationSyncWarning: NoteMutationSyncWarningTarget | null;
  mutationSyncWarningRefreshing: boolean;
  mutationSyncWarningError: string | null;
  focusMutationSyncWarningActionOnMount: boolean;
  onMutationSyncWarning: (
    warning: NoteMutationSyncWarningTarget,
    focusActionOnMount: boolean,
  ) => void;
  onRefreshMutation: (warning: NoteMutationSyncWarningTarget) => Promise<NoteMutationRecovery>;
  onUpdate: (note: Note, title: string, body: string) => Promise<NoteUpdateCommit>;
  onArchive: (note: Note) => Promise<NoteArchiveCommit>;
  onOpenLink: (url: string) => void;
  onOpenAssistant: (note: Note) => void;
}

export function NotePage({
  workspaceName,
  notes,
  status,
  loadError,
  operationError,
  pendingNoteIds,
  pendingCreate,
  pendingMutation = false,
  pendingMutationMessage = null,
  requestedNoteId,
  onRequestedNoteHandled,
  onDirtyChange,
  onRetry,
  onCreate,
  createSyncWarning,
  onCreateSyncWarning,
  onCreateSyncResolved,
  onRefreshCreated,
  mutationSyncWarning = null,
  mutationSyncWarningRefreshing = false,
  mutationSyncWarningError = null,
  focusMutationSyncWarningActionOnMount = false,
  onMutationSyncWarning,
  onRefreshMutation,
  onUpdate,
  onArchive,
  onOpenLink,
  onOpenAssistant,
}: NotePageProps) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<NoteSelection>(null);
  const [draft, setDraft] = useState<NoteEditorState | null>(null);
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('edit');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focusCreateSyncWarningAction, setFocusCreateSyncWarningAction] = useState(false);
  const [focusMutationSyncWarningAction, setFocusMutationSyncWarningAction] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const saveInFlightRef = useRef(false);
  const createRecoveryPendingRef = useRef(createSyncWarning !== null);
  const mutationRecoveryPendingRef = useRef(mutationSyncWarning !== null);
  const visibleNotes = useMemo(() => filterNotes(notes, query), [notes, query]);
  const requestedNoteUnavailable =
    createSyncWarning === null &&
    mutationSyncWarning === null &&
    requestedNoteId !== null &&
    !notes.some(({ id }) => id === requestedNoteId);
  const selectedNoteUnavailable =
    createSyncWarning === null &&
    mutationSyncWarning === null &&
    requestedNoteId === null &&
    selection?.kind === 'note' &&
    !notes.some(({ id }) => id === selection.noteId);
  const editor = useMemo<NoteEditorState | null>(() => {
    if (createSyncWarning) {
      return {
        key: 'new',
        note: null,
        title: createSyncWarning.title,
        body: createSyncWarning.body,
      };
    }
    if (mutationSyncWarning) {
      const original = mutationSyncWarning.intent.originalNote;
      const committedNote =
        mutationSyncWarning.kind === 'update'
          ? {
              ...original,
              title: mutationSyncWarning.intent.title,
              body: mutationSyncWarning.intent.body,
              revision: mutationSyncWarning.intent.expectedCommittedRevision,
            }
          : original;
      return {
        key: original.id,
        note: committedNote,
        title: committedNote.title,
        body: committedNote.body,
      };
    }
    const requestedNote = requestedNoteId
      ? (notes.find(({ id }) => id === requestedNoteId) ?? null)
      : null;
    const selectedNote =
      selection?.kind === 'note' ? (notes.find(({ id }) => id === selection.noteId) ?? null) : null;
    const activeNote =
      requestedNoteId !== null
        ? requestedNote
        : selection?.kind === 'note'
          ? selectedNote
          : selection?.kind === 'new'
            ? null
            : (notes[0] ?? null);
    const editorKey =
      requestedNoteId !== null
        ? (activeNote?.id ?? null)
        : selection?.kind === 'new'
          ? 'new'
          : (activeNote?.id ?? null);
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
  }, [createSyncWarning, draft, mutationSyncWarning, notes, requestedNoteId, selection]);
  const dirty = editor ? isNoteDraftDirty(editor.note, editor.title, editor.body) : false;
  const titleLength = Array.from(editor?.title.trim() ?? '').length;
  const bodyLength = Array.from(editor?.body ?? '').length;
  const titleInvalid = titleLength < 1 || titleLength > NOTE_TITLE_MAX_LENGTH;
  const bodyInvalid = bodyLength > NOTE_BODY_MAX_LENGTH;
  const saving = editor?.note ? pendingNoteIds.has(editor.note.id) : pendingCreate;
  const createRecoveryPending = createSyncWarning !== null;
  const mutationRecoveryPending = mutationSyncWarning !== null;
  const unsavedDirty = dirty && !createRecoveryPending && !mutationRecoveryPending;
  const noteNavigationLocked =
    pendingCreate || pendingMutation || createRecoveryPending || mutationRecoveryPending;
  const editorLocked = saving || noteNavigationLocked;

  const confirmDiscard = useCallback(
    () => !unsavedDirty || window.confirm('这篇笔记有尚未保存的更改。要放弃这些更改并继续吗？'),
    [unsavedDirty],
  );

  const openNote = useCallback(
    (note: Note) => {
      if (
        noteNavigationLocked ||
        createRecoveryPendingRef.current ||
        mutationRecoveryPendingRef.current
      ) {
        return;
      }
      if (!confirmDiscard()) return;
      onRequestedNoteHandled();
      setSelection({ kind: 'note', noteId: note.id });
      setDraft(null);
      setEditorMode('edit');
      setSaveError(null);
    },
    [confirmDiscard, noteNavigationLocked, onRequestedNoteHandled],
  );

  const openNew = useCallback(() => {
    if (
      noteNavigationLocked ||
      createRecoveryPendingRef.current ||
      mutationRecoveryPendingRef.current
    ) {
      return;
    }
    if (!confirmDiscard()) return;
    onRequestedNoteHandled();
    setSelection({ kind: 'new' });
    setDraft(null);
    setEditorMode('edit');
    setSaveError(null);
    window.requestAnimationFrame(() => titleInputRef.current?.focus());
  }, [confirmDiscard, noteNavigationLocked, onRequestedNoteHandled]);

  useLayoutEffect(() => {
    createRecoveryPendingRef.current = createRecoveryPending;
    mutationRecoveryPendingRef.current = mutationRecoveryPending;
  }, [createRecoveryPending, mutationRecoveryPending]);

  useLayoutEffect(() => {
    onDirtyChange(unsavedDirty);
  }, [onDirtyChange, unsavedDirty]);

  useLayoutEffect(() => {
    if (!requestedNoteId || editor?.note?.id !== requestedNoteId) return;
    const frame = window.requestAnimationFrame(() => titleInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [editor?.note?.id, requestedNoteId]);

  useLayoutEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  const selectCreatedNote = useCallback(
    (note: Note, focusTitle: boolean, resetEditorMode: boolean): void => {
      onRequestedNoteHandled();
      setSelection({ kind: 'note', noteId: note.id });
      setDraft(null);
      if (resetEditorMode) setEditorMode('edit');
      setSaveError(null);
      setFocusCreateSyncWarningAction(false);
      setFocusMutationSyncWarningAction(false);
      createRecoveryPendingRef.current = false;
      mutationRecoveryPendingRef.current = false;
      if (focusTitle) {
        window.requestAnimationFrame(() => titleInputRef.current?.focus({ preventScroll: true }));
      }
    },
    [onRequestedNoteHandled],
  );

  const save = useCallback(async () => {
    if (
      !editor ||
      editorLocked ||
      saveInFlightRef.current ||
      createRecoveryPendingRef.current ||
      mutationRecoveryPendingRef.current ||
      titleInvalid ||
      bodyInvalid
    ) {
      return;
    }
    saveInFlightRef.current = true;
    let releaseAfterRender = false;
    const saveStartedFromButton = document.activeElement === saveButtonRef.current;
    setSaveError(null);
    try {
      if (editor.note) {
        const commit = await onUpdate(editor.note, editor.title, editor.body);
        const saved =
          commit.committed &&
          commit.updatedNote !== null &&
          commit.updatedNote.id === commit.intent.originalNote.id
            ? commit.updatedNote
            : null;
        if (saved) {
          releaseAfterRender = true;
          selectCreatedNote(saved, false, false);
          return;
        }

        mutationRecoveryPendingRef.current = true;
        releaseAfterRender = true;
        onMutationSyncWarning(
          noteUpdateWarning(commit),
          saveStartedFromButton &&
            (document.activeElement === saveButtonRef.current ||
              document.activeElement === document.body),
        );
        setFocusMutationSyncWarningAction(
          saveStartedFromButton &&
            (document.activeElement === saveButtonRef.current ||
              document.activeElement === document.body),
        );
        return;
      }

      const commit = await onCreate(editor.title, editor.body);
      const createdNote =
        commit.committed &&
        commit.createdNote !== null &&
        commit.createdNote.id === commit.result.createdNoteId
          ? commit.createdNote
          : null;
      if (createdNote) {
        releaseAfterRender = true;
        selectCreatedNote(createdNote, false, true);
        return;
      }

      createRecoveryPendingRef.current = true;
      releaseAfterRender = true;
      onCreateSyncWarning({
        result: commit.result,
        title: editor.title,
        body: editor.body,
        message:
          commit.reconciliationWarning ??
          '笔记已创建，但当前笔记列表未能同步。请重新读取后查看，避免重复创建。',
      });
      setFocusCreateSyncWarningAction(
        saveStartedFromButton &&
          (document.activeElement === saveButtonRef.current ||
            document.activeElement === document.body),
      );
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '笔记保存失败，请重试。');
    } finally {
      if (releaseAfterRender) {
        window.requestAnimationFrame(() => {
          saveInFlightRef.current = false;
        });
      } else {
        saveInFlightRef.current = false;
      }
    }
  }, [
    bodyInvalid,
    editor,
    editorLocked,
    onCreate,
    onCreateSyncWarning,
    onMutationSyncWarning,
    onUpdate,
    selectCreatedNote,
    titleInvalid,
  ]);

  const refreshCreatedNote = useCallback(async (): Promise<void> => {
    const warning = createSyncWarning;
    if (!warning) return;
    const createdNote = await onRefreshCreated(warning.result);
    if (!createdNote || createdNote.id !== warning.result.createdNoteId) {
      throw new Error('The exact created note could not be confirmed.');
    }
    onCreateSyncResolved(warning);
    selectCreatedNote(createdNote, true, true);
  }, [createSyncWarning, onCreateSyncResolved, onRefreshCreated, selectCreatedNote]);

  const refreshMutatedNote = useCallback(async (): Promise<void> => {
    const warning = mutationSyncWarning;
    if (!warning) return;
    const recovery = await onRefreshMutation(warning);
    if (warning.kind === 'update') {
      if (
        recovery.kind !== 'update' ||
        !recovery.committed ||
        recovery.updatedNote === null ||
        recovery.updatedNote.id !== warning.intent.originalNote.id
      ) {
        throw new Error('The exact updated note could not be confirmed.');
      }
      selectCreatedNote(recovery.updatedNote, true, false);
      return;
    }
    if (recovery.kind !== 'archive' || !recovery.committed || !recovery.confirmed) {
      throw new Error('The exact archived note could not be confirmed.');
    }
    onRequestedNoteHandled();
    setSelection(null);
    setDraft(null);
    setSaveError(null);
    setFocusMutationSyncWarningAction(false);
    mutationRecoveryPendingRef.current = false;
    window.requestAnimationFrame(() => pageHeadingRef.current?.focus({ preventScroll: true }));
  }, [mutationSyncWarning, onRefreshMutation, onRequestedNoteHandled, selectCreatedNote]);

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
    if (!note || editorLocked || archiving) return;
    if (dirty && !confirmDiscard()) return;
    if (!window.confirm(`归档“${note.title}”？内容仍会保留在本地备份中。`)) return;
    const archiveStartedFromButton = document.activeElement === archiveButtonRef.current;
    setArchiving(true);
    setSaveError(null);
    try {
      const commit = await onArchive(note);
      if (!commit.committed || !commit.confirmed) {
        mutationRecoveryPendingRef.current = true;
        const focusWarning =
          archiveStartedFromButton &&
          (document.activeElement === archiveButtonRef.current ||
            document.activeElement === document.body);
        onMutationSyncWarning(noteArchiveWarning(commit), focusWarning);
        setFocusMutationSyncWarningAction(focusWarning);
        return;
      }
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
            <h1 ref={pageHeadingRef} tabIndex={-1}>
              笔记
            </h1>
            <p>
              {status === 'ready' ? `${notes.length} 篇 Markdown 笔记` : '保存当前工作区的上下文。'}
            </p>
          </div>
        </div>
        <button type="button" className="primary-button" onClick={openNew} disabled={editorLocked}>
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
          {createSyncWarning ? (
            <NoteCreateSyncWarning
              title={createSyncWarning.title}
              message={createSyncWarning.message}
              focusActionOnMount={focusCreateSyncWarningAction}
              onRefresh={refreshCreatedNote}
            />
          ) : null}
          {mutationSyncWarning && createSyncWarning === null ? (
            <NoteMutationSyncWarning
              kind={mutationSyncWarning.kind}
              title={mutationSyncWarning.title}
              message={mutationSyncWarning.message}
              focusActionOnMount={
                focusMutationSyncWarningAction || focusMutationSyncWarningActionOnMount
              }
              refreshing={mutationSyncWarningRefreshing}
              refreshError={mutationSyncWarningError}
              onRefresh={refreshMutatedNote}
            />
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
                    disabled={noteNavigationLocked}
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
                      <button type="button" onClick={openNew} disabled={noteNavigationLocked}>
                        创建第一篇
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </aside>

            <div className="note-editor-shell">
              {requestedNoteUnavailable || selectedNoteUnavailable ? (
                <div className="note-editor-empty" role="alert">
                  <NotebookPen size={25} />
                  <h2>要打开的笔记已不可用</h2>
                  <p>它可能已被归档或工作区数据已经变化；没有打开其他笔记。</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      onRequestedNoteHandled();
                      setSelection(null);
                      setDraft(null);
                    }}
                  >
                    返回笔记列表
                  </button>
                </div>
              ) : editor ? (
                <form className="note-editor" onSubmit={submit}>
                  <header className="note-editor__toolbar">
                    <div className="segmented-control" role="tablist" aria-label="笔记编辑模式">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={editorMode === 'edit'}
                        className={editorMode === 'edit' ? 'is-active' : ''}
                        onClick={() => setEditorMode('edit')}
                        disabled={noteNavigationLocked}
                      >
                        <PencilLine size={13} /> 编辑
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={editorMode === 'preview'}
                        className={editorMode === 'preview' ? 'is-active' : ''}
                        onClick={() => setEditorMode('preview')}
                        disabled={noteNavigationLocked}
                      >
                        <FileText size={13} /> 预览
                      </button>
                    </div>
                    <span
                      className={`note-editor__status${saveError ? ' is-error' : ''}`}
                      role={createRecoveryPending || mutationRecoveryPending ? undefined : 'status'}
                    >
                      {createRecoveryPending
                        ? '已创建 · 等待同步'
                        : mutationRecoveryPending
                          ? mutationSyncWarning?.kind === 'archive'
                            ? '已归档 · 等待同步'
                            : '已保存 · 等待同步'
                          : pendingCreate
                            ? '正在确认新笔记…'
                            : pendingMutation
                              ? (pendingMutationMessage ?? '正在确认笔记写入…')
                              : saveError
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
                        className="note-editor__assistant"
                        onClick={() => {
                          if (editor.note) onOpenAssistant(editor.note);
                        }}
                        disabled={dirty || editorLocked || archiving}
                        aria-describedby={dirty ? 'note-assistant-disabled-reason' : undefined}
                      >
                        <MessageSquareText size={14} />
                        询问 AI
                      </button>
                    ) : null}
                    {editor.note && dirty ? (
                      <span className="sr-only" id="note-assistant-disabled-reason">
                        请先保存笔记，再将其作为 AI 上下文。
                      </span>
                    ) : null}
                    {editor.note ? (
                      <button
                        ref={archiveButtonRef}
                        type="button"
                        className="note-editor__archive"
                        onClick={() => void archiveCurrent()}
                        disabled={editorLocked || archiving}
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
                      ref={saveButtonRef}
                      type="submit"
                      className="note-editor__save"
                      disabled={!dirty || editorLocked || titleInvalid || bodyInvalid}
                    >
                      {saving || pendingCreate ? (
                        <LoaderCircle className="is-spinning" size={14} />
                      ) : (
                        <Check size={14} />
                      )}
                      {pendingCreate ? '创建中…' : saving ? '保存中…' : '保存'}
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
                      readOnly={noteNavigationLocked}
                      aria-invalid={titleInvalid}
                      aria-describedby={
                        createRecoveryPending
                          ? 'note-title-count note-create-sync-warning-message'
                          : mutationRecoveryPending
                            ? `note-title-count note-${mutationSyncWarning?.kind ?? 'update'}-sync-warning-message`
                            : 'note-title-count'
                      }
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
                        readOnly={noteNavigationLocked}
                        aria-invalid={bodyInvalid}
                        aria-describedby={
                          createRecoveryPending
                            ? 'note-body-count note-create-sync-warning-message'
                            : mutationRecoveryPending
                              ? `note-body-count note-${mutationSyncWarning?.kind ?? 'update'}-sync-warning-message`
                              : 'note-body-count'
                        }
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
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={openNew}
                    disabled={noteNavigationLocked}
                  >
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

function noteUpdateWarning(commit: NoteUpdateCommit): NoteMutationSyncWarningTarget {
  return {
    kind: 'update',
    intent: commit.intent,
    resultSnapshot: commit.result,
    title: commit.intent.title,
    message:
      commit.reconciliationWarning ??
      '笔记已保存，但当前笔记列表未能同步。请重新读取后查看，避免重复保存。',
  };
}

function noteArchiveWarning(commit: NoteArchiveCommit): NoteMutationSyncWarningTarget {
  return {
    kind: 'archive',
    intent: commit.intent,
    resultSnapshot: commit.result,
    title: commit.intent.originalNote.title,
    message:
      commit.reconciliationWarning ??
      '笔记已归档，但当前笔记列表未能同步。请重新读取后确认，避免重复归档。',
  };
}
