import { useCallback, useRef, useState } from "react";

/**
 * Controlled-or-uncontrolled value, the pattern every form primitive here uses:
 * pass `value` to control it, or `defaultValue` to let the component own it.
 * `onChange` fires in both modes.
 */
export function useControllable<T>(
  value: T | undefined,
  defaultValue: T,
  onChange: ((next: T) => void) | undefined,
): [T, (next: T) => void] {
  const [inner, setInner] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next);
      onChangeRef.current?.(next);
    },
    [controlled],
  );
  return [current, set];
}
