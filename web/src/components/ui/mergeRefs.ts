import type { Ref, RefCallback } from "react";

/** Combine refs so a wrapper and its caller can both hold the element. */
export function mergeRefs<T>(
  ...refs: Array<Ref<T> | undefined | null>
): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value);
      else if (ref) ref.current = value;
    }
  };
}

/** Call two optional event handlers in order. */
export function chainHandlers<E>(
  first: ((event: E) => void) | undefined,
  second: (event: E) => void,
): (event: E) => void {
  return (event) => {
    first?.(event);
    second(event);
  };
}
