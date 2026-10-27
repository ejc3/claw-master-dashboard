/**
 * Runs at most `max` tasks at a time; the rest start in the order they were given, each as one
 * before it ends. For one request's own work: on Workers, a promise one request makes must not
 * wait on another request's.
 */
export function inTurn(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  return async (task) => {
    // A slot that frees passes straight to the next in line, so `running` never goes over.
    if (running < max) running++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next === undefined) running--
      else next()
    }
  }
}
