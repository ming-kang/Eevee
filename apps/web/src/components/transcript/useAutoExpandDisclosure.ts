import { useCallback, useEffect, useRef, useState } from "react";

export type DisclosureState = {
  readonly open: boolean;
  readonly userInteracted: boolean;
  readonly wasLive: boolean;
};

export function createDisclosureState(live: boolean, initialOpen = live): DisclosureState {
  return {
    open: initialOpen,
    userInteracted: false,
    wasLive: live,
  };
}

export function stepDisclosureOnLiveChange(
  prev: DisclosureState,
  live: boolean,
  forceOpen?: boolean,
): DisclosureState {
  if (forceOpen) {
    return { open: true, userInteracted: prev.userInteracted, wasLive: live };
  }
  if (live === prev.wasLive) return prev;
  if (live) {
    return {
      open: prev.userInteracted ? prev.open : true,
      userInteracted: prev.userInteracted,
      wasLive: true,
    };
  }
  return {
    open: prev.userInteracted ? prev.open : false,
    userInteracted: prev.userInteracted,
    wasLive: false,
  };
}

export function stepDisclosureOnUserToggle(
  prev: DisclosureState,
  nextOpen: boolean,
): DisclosureState {
  return {
    open: nextOpen,
    userInteracted: true,
    wasLive: prev.wasLive,
  };
}

export function useAutoExpandDisclosure(
  live: boolean,
  options?: {
    readonly initialOpen?: boolean;
    readonly forceOpen?: boolean;
  },
): readonly [boolean, (nextOpen: boolean) => void] {
  const forceOpen = options?.forceOpen;
  const initialOpen = options?.initialOpen ?? (live || Boolean(forceOpen));
  const [state, setState] = useState<DisclosureState>(() =>
    createDisclosureState(live, initialOpen),
  );
  const prevForceRef = useRef(Boolean(forceOpen));

  useEffect(() => {
    const forceBecameTrue = Boolean(forceOpen) && !prevForceRef.current;
    prevForceRef.current = Boolean(forceOpen);
    setState((prev) => stepDisclosureOnLiveChange(prev, live, forceBecameTrue));
  }, [live, forceOpen]);

  const onOpenChange = useCallback((nextOpen: boolean) => {
    setState((prev) => stepDisclosureOnUserToggle(prev, nextOpen));
  }, []);

  return [state.open, onOpenChange] as const;
}
