import type { SearchResult, SearchResultKind, SearchScope } from '../../shared/contracts';
import {
  SEARCH_EXCERPT_MAX_LENGTH,
  SEARCH_RESULT_LIMIT,
  SEARCH_RESULT_PER_KIND_LIMIT,
  escapeSearchLike,
  searchQueryLength,
  toSearchFtsPhrase,
} from '../../shared/search-domain';
import { normalizeBrowserId, normalizeBrowserTitle } from '../../shared/browser-domain';
import { normalizeInboxContent, normalizeInboxId } from '../../shared/inbox-domain';
import { normalizeNoteBody, normalizeNoteId, normalizeNoteTitle } from '../../shared/note-domain';
import {
  formatScheduleMinute,
  normalizeScheduleCivilDate,
  normalizeScheduleId,
  normalizeScheduleRange,
  normalizeScheduleTitle,
} from '../../shared/schedule-domain';
import { normalizeTaskId, normalizeTaskTitle } from '../../shared/task-domain';
import { normalizeWorkspaceId, normalizeWorkspaceName } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { normalizeBrowserUrl } from '../security/browser-url';

const QUERY_LIMIT = SEARCH_RESULT_PER_KIND_LIMIT + 1;

interface SearchRow {
  entity_id: unknown;
  workspace_id: unknown;
  workspace_name: unknown;
  title: unknown;
  content: unknown;
  url: unknown;
  scheduled_for: unknown;
  start_minute: unknown;
  end_minute: unknown;
  sort_at: unknown;
  match_tier: unknown;
  workspace_rank: unknown;
  relevance: unknown;
}

interface RankedSearchResult {
  readonly result: SearchResult;
  readonly matchTier: number;
  readonly workspaceRank: number;
  readonly relevance: number;
}

interface SearchKindBatch {
  readonly kind: SearchResultKind;
  readonly items: readonly RankedSearchResult[];
}

export interface SearchRepositoryInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly scope: SearchScope;
  readonly todayDate: string;
}

export interface SearchRepositoryResult {
  readonly results: readonly SearchResult[];
  readonly truncated: boolean;
  readonly truncatedKinds: readonly SearchResultKind[];
}

export class SearchRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  validateSnapshot(): void {
    for (const index of SEARCH_INDEXES) {
      const objects = this.#database.all<{ name: unknown; type: unknown }>(
        `SELECT name, type
         FROM sqlite_schema
         WHERE name IN (${index.objects.map(() => '?').join(', ')})
         ORDER BY name`,
        index.objects,
      );
      if (
        objects.length !== index.objects.length ||
        objects.some(
          (object, objectIndex) =>
            object.name !== index.objects[objectIndex] ||
            object.type !== (object.name === index.table ? 'table' : 'trigger'),
        )
      ) {
        throw new DatabaseIntegrityError('A workspace search index is incomplete.');
      }

      const sourceCount = this.#readCount(index.source);
      const documentCount = this.#readCount(index.documents);
      const identityMismatch = this.#database.get<{ rowid: unknown }>(
        `SELECT source.rowid
         FROM ${index.source} AS source
         LEFT JOIN ${index.documents} AS document ON document.id = source.rowid
         WHERE document.id IS NULL
         UNION ALL
         SELECT document.id AS rowid
         FROM ${index.documents} AS document
         LEFT JOIN ${index.source} AS source ON source.rowid = document.id
         WHERE source.rowid IS NULL
         LIMIT 1`,
      );
      if (sourceCount !== documentCount || identityMismatch) {
        throw new DatabaseIntegrityError('A workspace search index is out of sync.');
      }

      this.#database.get(
        `SELECT rowid
         FROM ${index.table}
         WHERE ${index.table} MATCH ?
         LIMIT 1`,
        ['"daily workbench search validation"'],
      );
    }
  }

  validateContentIntegrity(): void {
    for (const index of SEARCH_INDEXES) {
      try {
        this.#database.run(
          `INSERT INTO ${index.table}(${index.table}, rank)
           VALUES ('integrity-check', 1)`,
        );
      } catch (error) {
        throw new DatabaseIntegrityError(
          'A workspace search index does not match its content table.',
          { cause: error },
        );
      }
    }
  }

  search(input: SearchRepositoryInput): SearchRepositoryResult {
    const context = createQueryContext(input);
    const batches: readonly SearchKindBatch[] = [
      { kind: 'inbox', items: this.#searchInbox(context) },
      { kind: 'task', items: this.#searchTasks(context) },
      { kind: 'note', items: this.#searchNotes(context) },
      { kind: 'schedule', items: this.#searchSchedule(context) },
      { kind: 'browser-tab', items: this.#searchBrowserTabs(context) },
      { kind: 'browser-bookmark', items: this.#searchBrowserBookmarks(context) },
    ];

    const truncatedKinds = new Set<SearchResultKind>();
    const candidates: RankedSearchResult[] = [];
    for (const batch of batches) {
      if (batch.items.length > SEARCH_RESULT_PER_KIND_LIMIT) {
        truncatedKinds.add(batch.kind);
      }
      candidates.push(...batch.items.slice(0, SEARCH_RESULT_PER_KIND_LIMIT));
    }

    candidates.sort(compareRankedResults);
    for (const candidate of candidates.slice(SEARCH_RESULT_LIMIT)) {
      truncatedKinds.add(candidate.result.kind);
    }
    const orderedTruncatedKinds = SEARCH_KIND_ORDER.filter((kind) => truncatedKinds.has(kind));
    return {
      results: candidates.slice(0, SEARCH_RESULT_LIMIT).map(({ result }) => result),
      truncated: orderedTruncatedKinds.length > 0,
      truncatedKinds: orderedTruncatedKinds,
    };
  }

  #searchInbox(context: QueryContext): RankedSearchResult[] {
    const match = createMatchClause(context, 'inbox_entries_search', ['content']);
    const rows = this.#database.all<SearchRow>(
      `SELECT inbox.id AS entity_id,
              inbox.workspace_id,
              workspace.name AS workspace_name,
              inbox.content AS title,
              NULL AS content,
              NULL AS url,
              NULL AS scheduled_for,
              NULL AS start_minute,
              NULL AS end_minute,
              inbox.updated_at AS sort_at,
              ${titleMatchTierSql('inbox.content')} AS match_tier,
              CASE WHEN inbox.workspace_id = ? THEN 0 ELSE 1 END AS workspace_rank,
              ${match.relevanceSql} AS relevance
       FROM inbox_entries_search
       JOIN inbox_entries AS inbox ON inbox.rowid = inbox_entries_search.rowid
       JOIN workspaces AS workspace ON workspace.id = inbox.workspace_id
       WHERE workspace.archived_at IS NULL
         AND inbox.archived_at IS NULL
         ${scopeSql(context, 'inbox.workspace_id')}
         AND ${match.sql}
       ORDER BY match_tier, workspace_rank, relevance, inbox.updated_at DESC, inbox.id
       LIMIT ?`,
      [
        ...titleMatchParameters(context),
        context.workspaceId,
        ...scopeParameters(context),
        ...match.parameters,
        QUERY_LIMIT,
      ],
    );
    return rows.map((row) => mapInboxRow(row));
  }

  #searchTasks(context: QueryContext): RankedSearchResult[] {
    const match = createMatchClause(context, 'tasks_search', ['title']);
    const rows = this.#database.all<SearchRow>(
      `SELECT task.id AS entity_id,
              task.workspace_id,
              workspace.name AS workspace_name,
              task.title,
              NULL AS content,
              NULL AS url,
              NULL AS scheduled_for,
              NULL AS start_minute,
              NULL AS end_minute,
              task.updated_at AS sort_at,
              ${titleMatchTierSql('task.title')} AS match_tier,
              CASE WHEN task.workspace_id = ? THEN 0 ELSE 1 END AS workspace_rank,
              ${match.relevanceSql} AS relevance
       FROM tasks_search
       JOIN tasks AS task ON task.rowid = tasks_search.rowid
       JOIN workspaces AS workspace ON workspace.id = task.workspace_id
       WHERE workspace.archived_at IS NULL
         ${scopeSql(context, 'task.workspace_id')}
         AND ${match.sql}
       ORDER BY match_tier, workspace_rank, relevance, task.updated_at DESC, task.id
       LIMIT ?`,
      [
        ...titleMatchParameters(context),
        context.workspaceId,
        ...scopeParameters(context),
        ...match.parameters,
        QUERY_LIMIT,
      ],
    );
    return rows.map((row) => mapTitleRow(row, 'task'));
  }

  #searchNotes(context: QueryContext): RankedSearchResult[] {
    const match = createMatchClause(context, 'notes_search', ['title', 'body']);
    const rows = this.#database.all<SearchRow>(
      `SELECT note.id AS entity_id,
              note.workspace_id,
              workspace.name AS workspace_name,
              note.title,
              note.body AS content,
              NULL AS url,
              NULL AS scheduled_for,
              NULL AS start_minute,
              NULL AS end_minute,
              note.updated_at AS sort_at,
              ${titleMatchTierSql('note.title', 4)} AS match_tier,
              CASE WHEN note.workspace_id = ? THEN 0 ELSE 1 END AS workspace_rank,
              ${match.relevanceSql} AS relevance
       FROM notes_search
       JOIN notes AS note ON note.rowid = notes_search.rowid
       JOIN workspaces AS workspace ON workspace.id = note.workspace_id
       WHERE workspace.archived_at IS NULL
         AND note.archived_at IS NULL
         ${scopeSql(context, 'note.workspace_id')}
         AND ${match.sql}
       ORDER BY match_tier, workspace_rank, relevance, note.updated_at DESC, note.id
       LIMIT ?`,
      [
        ...titleMatchParameters(context),
        context.workspaceId,
        ...scopeParameters(context),
        ...match.parameters,
        QUERY_LIMIT,
      ],
    );
    return rows.map((row) => mapNoteRow(row, context.query));
  }

  #searchSchedule(context: QueryContext): RankedSearchResult[] {
    const match = createMatchClause(context, 'schedule_items_search', ['title']);
    const rows = this.#database.all<SearchRow>(
      `SELECT schedule.id AS entity_id,
              schedule.workspace_id,
              workspace.name AS workspace_name,
              schedule.title,
              NULL AS content,
              NULL AS url,
              schedule.scheduled_for,
              schedule.start_minute,
              schedule.end_minute,
              schedule.updated_at AS sort_at,
              ${titleMatchTierSql('schedule.title')} AS match_tier,
              CASE WHEN schedule.workspace_id = ? THEN 0 ELSE 1 END AS workspace_rank,
              ${match.relevanceSql} AS relevance
       FROM schedule_items_search
       JOIN schedule_items AS schedule ON schedule.rowid = schedule_items_search.rowid
       JOIN workspaces AS workspace ON workspace.id = schedule.workspace_id
       WHERE workspace.archived_at IS NULL
         AND schedule.archived_at IS NULL
         AND schedule.scheduled_for = ?
         ${scopeSql(context, 'schedule.workspace_id')}
         AND ${match.sql}
       ORDER BY match_tier, workspace_rank, relevance,
                schedule.start_minute, schedule.end_minute, schedule.id
       LIMIT ?`,
      [
        ...titleMatchParameters(context),
        context.workspaceId,
        context.todayDate,
        ...scopeParameters(context),
        ...match.parameters,
        QUERY_LIMIT,
      ],
    );
    return rows.map((row) => mapScheduleRow(row));
  }

  #searchBrowserTabs(context: QueryContext): RankedSearchResult[] {
    const match = createMatchClause(context, 'browser_tabs_search', ['title', 'url']);
    const rows = this.#database.all<SearchRow>(
      `SELECT tab.id AS entity_id,
              tab.workspace_id,
              workspace.name AS workspace_name,
              tab.title,
              NULL AS content,
              tab.url,
              NULL AS scheduled_for,
              NULL AS start_minute,
              NULL AS end_minute,
              tab.updated_at AS sort_at,
              ${titleOrUrlMatchTierSql('tab.title', 'tab.url')} AS match_tier,
              CASE WHEN tab.workspace_id = ? THEN 0 ELSE 1 END AS workspace_rank,
              ${match.relevanceSql} AS relevance
       FROM browser_tabs_search
       JOIN browser_tabs AS tab ON tab.rowid = browser_tabs_search.rowid
       JOIN workspaces AS workspace ON workspace.id = tab.workspace_id
       WHERE workspace.archived_at IS NULL
         ${scopeSql(context, 'tab.workspace_id')}
         AND ${match.sql}
       ORDER BY match_tier, workspace_rank, relevance, tab.updated_at DESC, tab.id
       LIMIT ?`,
      [
        ...titleOrUrlMatchParameters(context),
        context.workspaceId,
        ...scopeParameters(context),
        ...match.parameters,
        QUERY_LIMIT,
      ],
    );
    return rows.map((row) => mapBrowserRow(row, 'browser-tab', context.query));
  }

  #searchBrowserBookmarks(context: QueryContext): RankedSearchResult[] {
    const match = createMatchClause(context, 'browser_bookmarks_search', ['title', 'url']);
    const rows = this.#database.all<SearchRow>(
      `SELECT bookmark.id AS entity_id,
              bookmark.workspace_id,
              workspace.name AS workspace_name,
              bookmark.title,
              NULL AS content,
              bookmark.url,
              NULL AS scheduled_for,
              NULL AS start_minute,
              NULL AS end_minute,
              bookmark.created_at AS sort_at,
              ${titleOrUrlMatchTierSql('bookmark.title', 'bookmark.url')} AS match_tier,
              CASE WHEN bookmark.workspace_id = ? THEN 0 ELSE 1 END AS workspace_rank,
              ${match.relevanceSql} AS relevance
       FROM browser_bookmarks_search
       JOIN browser_bookmarks AS bookmark ON bookmark.rowid = browser_bookmarks_search.rowid
       JOIN workspaces AS workspace ON workspace.id = bookmark.workspace_id
       WHERE workspace.archived_at IS NULL
         ${scopeSql(context, 'bookmark.workspace_id')}
         AND ${match.sql}
       ORDER BY match_tier, workspace_rank, relevance, bookmark.created_at DESC, bookmark.id
       LIMIT ?`,
      [
        ...titleOrUrlMatchParameters(context),
        context.workspaceId,
        ...scopeParameters(context),
        ...match.parameters,
        QUERY_LIMIT,
      ],
    );
    return rows.map((row) => mapBrowserRow(row, 'browser-bookmark', context.query));
  }

  #readCount(table: string): number {
    const row = this.#database.get<{ count: unknown }>(`SELECT COUNT(*) AS count FROM ${table}`);
    if (!row || !Number.isSafeInteger(row.count) || (row.count as number) < 0) {
      throw new DatabaseIntegrityError('SQLite returned an invalid search index row count.');
    }
    return row.count as number;
  }
}

const SEARCH_INDEXES = [
  {
    table: 'inbox_entries_search',
    documents: 'inbox_entries_search_docsize',
    source: 'inbox_entries',
    objects: [
      'inbox_entries_search',
      'inbox_entries_search_delete',
      'inbox_entries_search_insert',
      'inbox_entries_search_update',
    ],
  },
  {
    table: 'tasks_search',
    documents: 'tasks_search_docsize',
    source: 'tasks',
    objects: ['tasks_search', 'tasks_search_delete', 'tasks_search_insert', 'tasks_search_update'],
  },
  {
    table: 'notes_search',
    documents: 'notes_search_docsize',
    source: 'notes',
    objects: ['notes_search', 'notes_search_delete', 'notes_search_insert', 'notes_search_update'],
  },
  {
    table: 'schedule_items_search',
    documents: 'schedule_items_search_docsize',
    source: 'schedule_items',
    objects: [
      'schedule_items_search',
      'schedule_items_search_delete',
      'schedule_items_search_insert',
      'schedule_items_search_update',
    ],
  },
  {
    table: 'browser_tabs_search',
    documents: 'browser_tabs_search_docsize',
    source: 'browser_tabs',
    objects: [
      'browser_tabs_search',
      'browser_tabs_search_delete',
      'browser_tabs_search_insert',
      'browser_tabs_search_update',
    ],
  },
  {
    table: 'browser_bookmarks_search',
    documents: 'browser_bookmarks_search_docsize',
    source: 'browser_bookmarks',
    objects: [
      'browser_bookmarks_search',
      'browser_bookmarks_search_delete',
      'browser_bookmarks_search_insert',
    ],
  },
] as const;

interface QueryContext extends SearchRepositoryInput {
  readonly likeContains: string;
  readonly likePrefix: string;
  readonly ftsPhrase: string;
  readonly useFts: boolean;
}

interface MatchClause {
  readonly sql: string;
  readonly relevanceSql: string;
  readonly parameters: readonly string[];
}

function createQueryContext(input: SearchRepositoryInput): QueryContext {
  const escaped = escapeSearchLike(input.query);
  return {
    ...input,
    likeContains: `%${escaped}%`,
    likePrefix: `${escaped}%`,
    ftsPhrase: toSearchFtsPhrase(input.query),
    useFts: searchQueryLength(input.query) >= 3,
  };
}

function createMatchClause(
  context: QueryContext,
  table: string,
  columns: readonly string[],
): MatchClause {
  if (context.useFts) {
    const weights =
      columns.length === 1
        ? ''
        : `, ${columns.map((_, index) => (index === 0 ? 8 : 1)).join(', ')}`;
    return {
      sql: `${table} MATCH ?`,
      relevanceSql: `bm25(${table}${weights})`,
      parameters: [context.ftsPhrase],
    };
  }
  return {
    sql: `(${columns.map((column) => `${table}.${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    relevanceSql: '0',
    parameters: columns.map(() => context.likeContains),
  };
}

function scopeSql(context: QueryContext, workspaceColumn: string): string {
  return context.scope === 'workspace' ? `AND ${workspaceColumn} = ?` : '';
}

function scopeParameters(context: QueryContext): readonly string[] {
  return context.scope === 'workspace' ? [context.workspaceId] : [];
}

function titleMatchTierSql(column: string, contentTier = 3): string {
  return `CASE
            WHEN ${column} COLLATE NOCASE = ? THEN 0
            WHEN ${column} COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 1
            WHEN ${column} COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 2
            ELSE ${contentTier}
          END`;
}

function titleMatchParameters(context: QueryContext): readonly string[] {
  return [context.query, context.likePrefix, context.likeContains];
}

function titleOrUrlMatchTierSql(titleColumn: string, urlColumn: string): string {
  return `CASE
            WHEN ${titleColumn} COLLATE NOCASE = ? THEN 0
            WHEN ${titleColumn} COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 1
            WHEN ${titleColumn} COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 2
            WHEN ${urlColumn} COLLATE NOCASE = ? THEN 3
            WHEN ${urlColumn} COLLATE NOCASE LIKE ? ESCAPE '\\' THEN 3
            ELSE 3
          END`;
}

function titleOrUrlMatchParameters(context: QueryContext): readonly string[] {
  return [
    context.query,
    context.likePrefix,
    context.likeContains,
    context.query,
    context.likePrefix,
  ];
}

const SEARCH_KIND_ORDER: readonly SearchResultKind[] = [
  'inbox',
  'task',
  'note',
  'schedule',
  'browser-tab',
  'browser-bookmark',
];

const SEARCH_KIND_RANK = new Map(SEARCH_KIND_ORDER.map((kind, index) => [kind, index]));

function compareRankedResults(left: RankedSearchResult, right: RankedSearchResult): number {
  if (left.matchTier !== right.matchTier) return left.matchTier - right.matchTier;
  if (left.workspaceRank !== right.workspaceRank) return left.workspaceRank - right.workspaceRank;
  const kindDifference =
    (SEARCH_KIND_RANK.get(left.result.kind) ?? Number.MAX_SAFE_INTEGER) -
    (SEARCH_KIND_RANK.get(right.result.kind) ?? Number.MAX_SAFE_INTEGER);
  if (kindDifference !== 0) return kindDifference;
  if (left.relevance !== right.relevance) return left.relevance - right.relevance;
  if (left.result.sortAt !== right.result.sortAt) {
    return right.result.sortAt.localeCompare(left.result.sortAt);
  }
  if (left.result.workspaceId !== right.result.workspaceId) {
    return left.result.workspaceId.localeCompare(right.result.workspaceId);
  }
  return left.result.entityId.localeCompare(right.result.entityId);
}

function mapInboxRow(row: SearchRow): RankedSearchResult {
  const base = readBaseRow(row, 'inbox');
  let entityId: string;
  let title: string;
  try {
    entityId = normalizeInboxId(row.entity_id);
    title = normalizeInboxContent(row.title);
  } catch (error) {
    throw invalidSearchRow('inbox', error);
  }
  return {
    ...base.rank,
    result: {
      kind: 'inbox',
      entityId,
      ...base.result,
      title,
      excerpt: null,
      matchField: 'content',
    },
  };
}

function mapTitleRow(row: SearchRow, kind: 'task'): RankedSearchResult {
  const base = readBaseRow(row, kind);
  let entityId: string;
  let title: string;
  try {
    entityId = normalizeTaskId(row.entity_id);
    title = normalizeTaskTitle(row.title);
  } catch (error) {
    throw invalidSearchRow(kind, error);
  }
  return {
    ...base.rank,
    result: {
      kind,
      entityId,
      ...base.result,
      title,
      excerpt: null,
      matchField: 'title',
    },
  };
}

function mapNoteRow(row: SearchRow, query: string): RankedSearchResult {
  const base = readBaseRow(row, 'note');
  let entityId: string;
  let title: string;
  let body: string;
  try {
    entityId = normalizeNoteId(row.entity_id);
    title = normalizeNoteTitle(row.title);
    body = normalizeNoteBody(row.content);
  } catch (error) {
    throw invalidSearchRow('note', error);
  }
  const titleMatches = containsFolded(title, query);
  return {
    ...base.rank,
    result: {
      kind: 'note',
      entityId,
      ...base.result,
      title,
      excerpt: createExcerpt(body, query),
      matchField: titleMatches ? 'title' : 'content',
    },
  };
}

function mapScheduleRow(row: SearchRow): RankedSearchResult {
  const base = readBaseRow(row, 'schedule');
  let entityId: string;
  let title: string;
  let scheduledFor: string;
  let startMinute: number;
  let endMinute: number;
  try {
    entityId = normalizeScheduleId(row.entity_id);
    title = normalizeScheduleTitle(row.title);
    scheduledFor = normalizeScheduleCivilDate(row.scheduled_for);
    ({ startMinute, endMinute } = normalizeScheduleRange(row.start_minute, row.end_minute));
  } catch (error) {
    throw invalidSearchRow('schedule', error);
  }
  return {
    ...base.rank,
    result: {
      kind: 'schedule',
      entityId,
      ...base.result,
      title,
      excerpt: `${scheduledFor} · ${formatScheduleMinute(startMinute)}–${formatScheduleMinute(endMinute)}`,
      matchField: 'title',
    },
  };
}

function mapBrowserRow(
  row: SearchRow,
  kind: 'browser-tab' | 'browser-bookmark',
  query: string,
): RankedSearchResult {
  const base = readBaseRow(row, kind);
  let entityId: string;
  let title: string;
  let url: string;
  try {
    entityId = normalizeBrowserId(row.entity_id);
    title = normalizeBrowserTitle(row.title);
    if (typeof row.url !== 'string') throw new TypeError('Browser search URL must be a string.');
    url = normalizeBrowserUrl(row.url);
  } catch (error) {
    throw invalidSearchRow(kind, error);
  }
  const titleMatches = containsFolded(title, query);
  return {
    ...base.rank,
    result: {
      kind,
      entityId,
      ...base.result,
      title,
      excerpt: createExcerpt(url, query),
      matchField: titleMatches ? 'title' : 'url',
    },
  };
}

function readBaseRow(
  row: SearchRow,
  kind: SearchResultKind,
): {
  readonly result: {
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly sortAt: string;
  };
  readonly rank: {
    readonly matchTier: number;
    readonly workspaceRank: number;
    readonly relevance: number;
  };
} {
  let workspaceId: string;
  let workspaceName: string;
  try {
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    workspaceName = normalizeWorkspaceName(row.workspace_name);
  } catch (error) {
    throw invalidSearchRow(kind, error);
  }
  if (!isIsoTimestamp(row.sort_at)) {
    throw invalidSearchRow(kind, new TypeError('Search result timestamp is invalid.'));
  }
  return {
    result: { workspaceId, workspaceName, sortAt: row.sort_at },
    rank: {
      matchTier: readInteger(row.match_tier, 'match tier', 0, 4),
      workspaceRank: readInteger(row.workspace_rank, 'workspace rank', 0, 1),
      relevance: readFiniteNumber(row.relevance, 'relevance'),
    },
  };
}

function createExcerpt(value: string, query: string): string | null {
  const plainText = value
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+[.)]\s)/gmu, '')
    .replace(/[*_~`]/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!plainText) return null;

  const characters = Array.from(plainText);
  if (characters.length <= SEARCH_EXCERPT_MAX_LENGTH) return plainText;

  const matchIndex = plainText.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const matchCharacterIndex =
    matchIndex < 0 ? 0 : Array.from(plainText.slice(0, matchIndex)).length;
  const start = Math.max(0, matchCharacterIndex - 48);
  const end = Math.min(characters.length, start + SEARCH_EXCERPT_MAX_LENGTH);
  return `${start > 0 ? '…' : ''}${characters.slice(start, end).join('')}${
    end < characters.length ? '…' : ''
  }`;
}

function containsFolded(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid search ${name}.`);
  }
  return value as number;
}

function readFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid search ${name}.`);
  }
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function invalidSearchRow(kind: SearchResultKind, cause: unknown): DatabaseIntegrityError {
  return new DatabaseIntegrityError(`The ${kind} search result contains invalid values.`, {
    cause,
  });
}
