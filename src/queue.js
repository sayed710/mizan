/**
 * Run async tasks one after another. A failed task goes to its own error handler and the queue keeps going:
 * a rejected link in a plain promise chain would silently skip every later task.
 */
export function createQueue() {
  let tail = Promise.resolve();
  return (task, onError) => {
    const run = tail.then(task).catch(onError);
    tail = run.catch(() => {});
    return run;
  };
}
