import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FocusSession, FocusSnapshot } from '../../shared/contracts';
import {
  createFocusRequestIdentity,
  createFocusWorkspaceIdentity,
  focusRemainingSeconds,
  focusStableClockNow,
  isFocusRequestCurrent,
  isFocusSnapshotDateCurrent,
  shouldApplyFocusSnapshot,
  type FocusRequestIdentity,
  type FocusWorkspaceIdentity,
} from '../focus-state';
import { millisecondsUntilNextLocalDay } from '../task-state';

export type FocusControllerStatus = 'loading' | 'ready' | 'error';
export type FocusControllerOperation = 'start' | 'pause' | 'resume' | 'cancel' | null;

interface StoredSnapshot {
  readonly activation: FocusWorkspaceIdentity;
  readonly snapshot: FocusSnapshot;
}

interface FocusLoadState {
  readonly activation: FocusWorkspaceIdentity;
  readonly status: FocusControllerStatus;
  readonly error: string | null;
}

interface FocusOperationError {
  readonly activation: FocusWorkspaceIdentity;
  readonly message: string;
}

const INACTIVE_ACTIVATION = Object.freeze(createFocusWorkspaceIdentity(null));

export function useFocusController(workspaceId: string | null) {
  const focusApi = window.workbench?.focus;
  const activation = useMemo(() => createFocusWorkspaceIdentity(workspaceId), [workspaceId]);
  const activeActivationRef = useRef<FocusWorkspaceIdentity>(activation);
  const [storedSnapshot, setStoredSnapshot] = useState<StoredSnapshot | null>(null);
  const storedSnapshotRef = useRef<StoredSnapshot | null>(null);
  const [loadState, setLoadState] = useState<FocusLoadState>({
    activation,
    status: 'loading',
    error: null,
  });
  const [operation, setOperation] = useState<FocusControllerOperation>(null);
  const operationRef = useRef<FocusControllerOperation>(null);
  const operationGenerationRef = useRef(0);
  const [operationError, setOperationError] = useState<FocusOperationError | null>(null);
  const requestSequenceRef = useRef(0);
  const latestRequestedSequenceRef = useRef(-1);
  const lastAppliedSequenceRef = useRef(-1);
  const eventRefreshTimerRef = useRef<number | null>(null);
  const completionRefreshKeyRef = useRef<string | null>(null);
  const [clockNow, setClockNow] = useState(readStableFocusClock);

  const setStored = useCallback((value: StoredSnapshot | null) => {
    storedSnapshotRef.current = value;
    setStoredSnapshot(value);
  }, []);

  const beginRequest = useCallback(
    (target: FocusWorkspaceIdentity): FocusRequestIdentity | null => {
      if (target.workspaceId === null) return null;
      const sequence = ++requestSequenceRef.current;
      latestRequestedSequenceRef.current = sequence;
      return createFocusRequestIdentity(target, sequence);
    },
    [],
  );

  const requestIsCurrent = useCallback(
    (request: FocusRequestIdentity): boolean =>
      isFocusRequestCurrent(activeActivationRef.current, request),
    [],
  );

  const applySnapshot = useCallback(
    (incoming: FocusSnapshot, request: FocusRequestIdentity, now: Date = new Date()): boolean => {
      if (
        !shouldApplyFocusSnapshot(
          activeActivationRef.current,
          lastAppliedSequenceRef.current,
          request,
          incoming,
          now,
        )
      ) {
        return false;
      }
      lastAppliedSequenceRef.current = request.sequence;
      setStored({ activation: request.workspace, snapshot: incoming });
      setLoadState({
        activation: request.workspace,
        status: 'ready',
        error: null,
      });
      setClockNow(readStableFocusClock());
      return true;
    },
    [setStored],
  );

  const load = useCallback(
    async (target: FocusWorkspaceIdentity, showLoading: boolean): Promise<void> => {
      const request = beginRequest(target);
      if (!request || !focusApi) return;
      if (showLoading && requestIsCurrent(request)) {
        setLoadState({
          activation: request.workspace,
          status: 'loading',
          error: null,
        });
      }
      try {
        const incoming = await focusApi.getSnapshot({ workspaceId: request.workspaceId });
        const applied = applySnapshot(incoming, request);
        if (
          !applied &&
          requestIsCurrent(request) &&
          request.sequence === latestRequestedSequenceRef.current &&
          (incoming.workspaceId !== request.workspaceId ||
            !isFocusSnapshotDateCurrent(incoming, new Date()))
        ) {
          setLoadState({
            activation: request.workspace,
            status: 'error',
            error: '专注会话已过期，请重新同步。',
          });
        }
      } catch (error) {
        if (!requestIsCurrent(request) || request.sequence !== latestRequestedSequenceRef.current) {
          return;
        }
        setLoadState({
          activation: request.workspace,
          status: 'error',
          error: toMessage(error, '专注会话暂时无法读取。'),
        });
      }
    },
    [applySnapshot, beginRequest, focusApi, requestIsCurrent],
  );

  useEffect(() => {
    activeActivationRef.current = activation;
    completionRefreshKeyRef.current = null;
    operationGenerationRef.current += 1;
    operationRef.current = null;
    queueMicrotask(() => {
      if (activeActivationRef.current !== activation) return;
      setOperation(null);
      setOperationError(null);
    });

    if (!focusApi || activation.workspaceId === null) {
      queueMicrotask(() => {
        if (activeActivationRef.current !== activation) return;
        setLoadState({
          activation,
          status: 'error',
          error: '桌面专注桥接不可用，请重新启动应用。',
        });
      });
      return () => {
        if (activeActivationRef.current === activation) {
          activeActivationRef.current = INACTIVE_ACTIVATION;
        }
      };
    }

    queueMicrotask(() => {
      if (activeActivationRef.current === activation) void load(activation, true);
    });
    return () => {
      if (activeActivationRef.current === activation) {
        activeActivationRef.current = INACTIVE_ACTIVATION;
      }
    };
  }, [activation, focusApi, load]);

  useEffect(() => {
    if (!focusApi) return;
    return focusApi.onChanged(() => {
      // Change events are invalidation hints only. Payload data is never used;
      // the next bounded read is rebound to the workspace active at that time.
      if (eventRefreshTimerRef.current !== null) return;
      eventRefreshTimerRef.current = window.setTimeout(() => {
        eventRefreshTimerRef.current = null;
        const current = activeActivationRef.current;
        if (current.workspaceId !== null) void load(current, false);
      }, 80);
    });
  }, [focusApi, load]);

  useEffect(
    () => () => {
      if (eventRefreshTimerRef.current !== null) {
        window.clearTimeout(eventRefreshTimerRef.current);
      }
    },
    [],
  );

  const storedSnapshotIsVisible =
    storedSnapshot?.activation === activation &&
    storedSnapshot.snapshot.workspaceId === workspaceId &&
    isFocusSnapshotDateCurrent(storedSnapshot.snapshot, new Date());
  const snapshot = storedSnapshotIsVisible ? storedSnapshot.snapshot : null;
  const visibleLoadState =
    loadState.activation === activation && !(loadState.status === 'ready' && !snapshot)
      ? loadState
      : {
          activation,
          status: 'loading' as const,
          error: null,
        };
  const remainingSeconds = useMemo(
    () => focusRemainingSeconds(snapshot, clockNow),
    [clockNow, snapshot],
  );
  const runningSession = snapshot?.session?.status === 'running' ? snapshot.session : null;

  useEffect(() => {
    if (!runningSession) return;
    const interval = window.setInterval(() => setClockNow(readStableFocusClock()), 1_000);
    return () => window.clearInterval(interval);
  }, [runningSession]);

  useEffect(() => {
    if (!runningSession || remainingSeconds !== 0) return;
    const refreshKey = `${runningSession.id}:${runningSession.revision}`;
    if (completionRefreshKeyRef.current === refreshKey) return;
    completionRefreshKeyRef.current = refreshKey;
    const current = activeActivationRef.current;
    if (current.workspaceId !== null) void load(current, false);
  }, [load, remainingSeconds, runningSession]);

  useEffect(() => {
    if (activation.workspaceId === null) return;
    let midnightTimer = 0;

    const refreshCurrent = (invalidateStaleDate: boolean) => {
      if (activeActivationRef.current !== activation) return;
      const current = storedSnapshotRef.current;
      if (
        invalidateStaleDate &&
        current?.activation === activation &&
        !isFocusSnapshotDateCurrent(current.snapshot, new Date())
      ) {
        setStored(null);
        setLoadState({
          activation,
          status: 'loading',
          error: null,
        });
      }
      void load(activation, false);
    };
    const scheduleMidnightRefresh = () => {
      window.clearTimeout(midnightTimer);
      midnightTimer = window.setTimeout(() => {
        refreshCurrent(true);
        scheduleMidnightRefresh();
      }, millisecondsUntilNextLocalDay(new Date()));
    };
    const handleFocus = () => refreshCurrent(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshCurrent(true);
    };

    scheduleMidnightRefresh();
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearTimeout(midnightTimer);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activation, load, setStored]);

  const runOperation = useCallback(
    async (
      kind: Exclude<FocusControllerOperation, null>,
      action: (
        request: FocusRequestIdentity,
        session: FocusSession | null,
      ) => Promise<FocusSnapshot>,
      requireOwnedSession: boolean,
    ): Promise<void> => {
      if (!focusApi) throw new Error('桌面专注桥接不可用。');
      if (operationRef.current !== null) {
        throw new Error('另一项专注操作正在进行，请稍候。');
      }
      const currentActivation = activeActivationRef.current;
      const request = beginRequest(currentActivation);
      if (!request) throw new Error('当前工作区不可用。');
      const current = storedSnapshotRef.current;
      const session =
        current?.activation === request.workspace &&
        current.snapshot.workspaceId === request.workspaceId
          ? current.snapshot.session
          : null;
      if (requireOwnedSession && (!session || session.workspaceId !== request.workspaceId)) {
        throw new Error('当前工作区没有可操作的专注会话。');
      }

      const operationGeneration = ++operationGenerationRef.current;
      operationRef.current = kind;
      setOperation(kind);
      setOperationError(null);
      try {
        applySnapshot(await action(request, session), request);
      } catch (error) {
        const message = toMessage(error, focusOperationFallback(kind));
        if (requestIsCurrent(request)) {
          setOperationError({
            activation: request.workspace,
            message,
          });
        }
        throw new Error(message, { cause: error });
      } finally {
        if (operationGenerationRef.current === operationGeneration) {
          operationRef.current = null;
          setOperation(null);
        }
      }
    },
    [applySnapshot, beginRequest, focusApi, requestIsCurrent],
  );

  const start = useCallback(
    (taskId?: string) =>
      runOperation(
        'start',
        (request) =>
          focusApi!.start({
            workspaceId: request.workspaceId,
            ...(taskId === undefined ? {} : { taskId }),
          }),
        false,
      ),
    [focusApi, runOperation],
  );

  const pause = useCallback(
    () =>
      runOperation(
        'pause',
        (request, session) =>
          focusApi!.pause({
            workspaceId: request.workspaceId,
            sessionId: session!.id,
            expectedRevision: session!.revision,
          }),
        true,
      ),
    [focusApi, runOperation],
  );

  const resume = useCallback(
    () =>
      runOperation(
        'resume',
        (request, session) =>
          focusApi!.resume({
            workspaceId: request.workspaceId,
            sessionId: session!.id,
            expectedRevision: session!.revision,
          }),
        true,
      ),
    [focusApi, runOperation],
  );

  const cancel = useCallback(
    () =>
      runOperation(
        'cancel',
        (request, session) =>
          focusApi!.cancel({
            workspaceId: request.workspaceId,
            sessionId: session!.id,
            expectedRevision: session!.revision,
          }),
        true,
      ),
    [focusApi, runOperation],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const current = activeActivationRef.current;
    if (current.workspaceId !== null) await load(current, false);
  }, [load]);

  const retry = useCallback(() => {
    const current = activeActivationRef.current;
    if (current.workspaceId !== null) void load(current, true);
  }, [load]);

  const currentOperationError =
    operationError?.activation === activation ? operationError.message : null;

  return {
    snapshot,
    status: snapshot ? ('ready' as const) : visibleLoadState.status,
    error: visibleLoadState.error ?? currentOperationError,
    operation,
    remainingSeconds,
    refresh,
    retry,
    start,
    pause,
    resume,
    cancel,
  };
}

function focusOperationFallback(operation: Exclude<FocusControllerOperation, null>): string {
  if (operation === 'start') return '无法开始专注，请重试。';
  if (operation === 'pause') return '无法暂停专注，请重试。';
  if (operation === 'resume') return '无法继续专注，请重试。';
  return '无法取消专注，请重试。';
}

function readStableFocusClock(): number {
  return focusStableClockNow(window.performance.timeOrigin, window.performance.now(), Date.now());
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
