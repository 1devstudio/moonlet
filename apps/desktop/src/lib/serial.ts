/** `fn` run one call at a time, in the order of the calls, so a slow earlier
 *  call cannot finish after, and undo, a later one. A failed call does not
 *  stop the ones after it. */
export function serial<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let queue: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
}
