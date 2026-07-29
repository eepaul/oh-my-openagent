import type { CountdownScheduler, CountdownTimerHandle } from "./types"

function supportsUnref(value: unknown): value is { readonly unref: () => void } {
  return typeof value === "object" && value !== null && "unref" in value && typeof value.unref === "function"
}

function createCountdownTimerHandle<TTimer>(
  timer: TTimer,
  cancel: (timer: TTimer) => void,
): CountdownTimerHandle {
  const unref = supportsUnref(timer) ? timer.unref.bind(timer) : undefined
  return {
    cancel: () => cancel(timer),
    ...(unref === undefined ? {} : { unref }),
  }
}

export const systemCountdownScheduler: CountdownScheduler = {
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay)
    return createCountdownTimerHandle(timer, clearTimeout)
  },
  clearTimeout: (timer) => timer.cancel(),
  setInterval: (callback, delay) => {
    const timer = setInterval(callback, delay)
    return createCountdownTimerHandle(timer, clearInterval)
  },
  clearInterval: (timer) => timer.cancel(),
}
