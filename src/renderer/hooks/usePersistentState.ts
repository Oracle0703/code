import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Transitional storage for prototype content that has not reached its own
 * SQLite milestone yet. Workspace identity and layout must not use this hook.
 */
export function usePersistentState<T>(
  key: string,
  initialValue: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const savedValue = window.localStorage.getItem(key);
      if (savedValue !== null) {
        return JSON.parse(savedValue) as T;
      }
    } catch {
      // Prototype content can still open with its default value.
    }

    return initialValue instanceof Function ? initialValue() : initialValue;
  });

  const setPersistentValue = useCallback<Dispatch<SetStateAction<T>>>(
    (nextValue) => {
      setValue((currentValue) => {
        const resolvedValue = nextValue instanceof Function ? nextValue(currentValue) : nextValue;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolvedValue));
        } catch {
          // Keep the prototype content in memory if storage is unavailable.
        }
        return resolvedValue;
      });
    },
    [key],
  );

  return [value, setPersistentValue];
}
