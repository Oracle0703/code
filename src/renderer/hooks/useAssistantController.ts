import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AssistantContextReference,
  AssistantCredentialStatus,
  AssistantSnapshot,
} from '../../shared/contracts';
import {
  normalizeAssistantApiKey,
  normalizeAssistantContextReference,
  normalizeAssistantPrompt,
} from '../../shared/assistant-domain';
import { shouldApplyAssistantSnapshot, visibleAssistantRuntime } from '../assistant-state';

type AssistantLoadStatus = 'loading' | 'ready' | 'error';
type AssistantOperation = 'start' | 'cancel' | 'configure' | 'remove' | null;

export function useAssistantController(workspaceId: string | null) {
  const assistantApi = window.workbench?.assistant;
  const [credential, setCredential] = useState<AssistantCredentialStatus | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<AssistantLoadStatus>('loading');
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AssistantSnapshot | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<AssistantLoadStatus>('loading');
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [operation, setOperation] = useState<AssistantOperation>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const workspaceIdRef = useRef(workspaceId);
  const requestGenerationRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const operationRef = useRef<AssistantOperation>(null);
  const latestSequenceRef = useRef(-1);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  const applySnapshot = useCallback((incoming: AssistantSnapshot): boolean => {
    if (
      !shouldApplyAssistantSnapshot(workspaceIdRef.current, latestSequenceRef.current, incoming)
    ) {
      return false;
    }
    latestSequenceRef.current = incoming.sequence;
    setSnapshot(incoming);
    setRuntimeStatus('ready');
    setRuntimeError(null);
    return true;
  }, []);

  const refresh = useCallback(() => {
    setLoadGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    latestSequenceRef.current = -1;
    operationGenerationRef.current += 1;
    operationRef.current = null;
    queueMicrotask(() => {
      if (requestGenerationRef.current !== generation) return;
      setOperation(null);
      setCredentialStatus('loading');
      setCredentialError(null);
      setRuntimeStatus('loading');
      setRuntimeError(null);
      setSnapshot(null);
    });

    if (!assistantApi || !workspaceId) {
      queueMicrotask(() => {
        if (requestGenerationRef.current !== generation) return;
        setCredentialStatus('error');
        setCredentialError('桌面 AI 桥接不可用，请重新启动应用。');
        setRuntimeStatus('error');
        setRuntimeError('当前工作区暂时无法连接 AI 助手。');
      });
      return;
    }

    const unsubscribe = assistantApi.onChanged((incoming) => {
      if (requestGenerationRef.current !== generation) return;
      applySnapshot(incoming);
    });

    void assistantApi
      .getCredentialStatus()
      .then((incoming) => {
        if (requestGenerationRef.current !== generation) return;
        setCredential(incoming);
        setCredentialStatus('ready');
        setCredentialError(null);
      })
      .catch(() => {
        if (requestGenerationRef.current !== generation) return;
        setCredential(null);
        setCredentialStatus('error');
        setCredentialError('无法读取 OpenAI 凭据状态。');
      });

    void assistantApi
      .getSnapshot()
      .then((incoming) => {
        if (requestGenerationRef.current !== generation) return;
        if (incoming.workspaceId !== workspaceIdRef.current) {
          setRuntimeStatus('error');
          setRuntimeError('工作区已变化，请重新加载 AI 助手。');
          return;
        }
        applySnapshot(incoming);
      })
      .catch(() => {
        if (requestGenerationRef.current !== generation) return;
        setSnapshot(null);
        setRuntimeStatus('error');
        setRuntimeError('无法读取当前工作区的 AI 会话。');
      });

    return () => {
      unsubscribe();
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [applySnapshot, assistantApi, loadGeneration, workspaceId]);

  const runOperation = useCallback(
    async <T>(kind: Exclude<AssistantOperation, null>, action: () => Promise<T>): Promise<T> => {
      if (operationRef.current !== null) {
        throw new Error('另一项 AI 操作正在进行，请稍候。');
      }
      const generation = ++operationGenerationRef.current;
      operationRef.current = kind;
      setOperation(kind);
      try {
        return await action();
      } finally {
        if (operationGenerationRef.current === generation) {
          operationRef.current = null;
          setOperation(null);
        }
      }
    },
    [],
  );

  const configureCredential = useCallback(
    async (apiKey: string): Promise<void> => {
      if (!assistantApi) throw new Error('桌面 AI 桥接不可用。');
      await runOperation('configure', async () => {
        const next = await assistantApi.configureCredential({
          apiKey: normalizeAssistantApiKey(apiKey),
        });
        setCredential(next);
        setCredentialStatus('ready');
        setCredentialError(null);
      });
    },
    [assistantApi, runOperation],
  );

  const removeCredential = useCallback(async (): Promise<void> => {
    if (!assistantApi) throw new Error('桌面 AI 桥接不可用。');
    await runOperation('remove', async () => {
      const next = await assistantApi.removeCredential();
      setCredential(next);
      setCredentialStatus('ready');
      setCredentialError(null);
    });
  }, [assistantApi, runOperation]);

  const start = useCallback(
    async (prompt: string, context: AssistantContextReference): Promise<void> => {
      if (!assistantApi) throw new Error('桌面 AI 桥接不可用。');
      await runOperation('start', async () => {
        const incoming = await assistantApi.start({
          prompt: normalizeAssistantPrompt(prompt),
          context: normalizeAssistantContextReference(context),
        });
        if (incoming.workspaceId !== workspaceIdRef.current) {
          throw new Error('工作区已变化，问题没有显示在当前页面。');
        }
        applySnapshot(incoming);
      });
    },
    [applySnapshot, assistantApi, runOperation],
  );

  const cancel = useCallback(
    async (runId: string): Promise<void> => {
      if (!assistantApi) throw new Error('桌面 AI 桥接不可用。');
      await runOperation('cancel', async () => {
        const incoming = await assistantApi.cancel({ runId });
        if (incoming.workspaceId !== workspaceIdRef.current) {
          throw new Error('工作区已变化，无法显示停止结果。');
        }
        applySnapshot(incoming);
      });
    },
    [applySnapshot, assistantApi, runOperation],
  );

  const visibleRuntime = visibleAssistantRuntime(
    workspaceId,
    snapshot,
    runtimeStatus,
    runtimeError,
  );

  return {
    credential,
    credentialStatus,
    credentialError,
    snapshot: visibleRuntime.snapshot,
    runtimeStatus: visibleRuntime.status,
    runtimeError: visibleRuntime.error,
    operation,
    retry: refresh,
    configureCredential,
    removeCredential,
    start,
    cancel,
  };
}
