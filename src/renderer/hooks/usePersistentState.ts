import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

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
      // A corrupt preference should never prevent the workbench from opening.
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
          // Preferences can still live in memory if storage is unavailable.
        }

        return resolvedValue;
      });
    },
    [key],
  );

  return [value, setPersistentValue];
}
