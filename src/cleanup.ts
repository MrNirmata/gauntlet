// What must not outlive the run: a child process, a temp directory. Each is
// tracked while it exists, and all of them are dealt with when Gauntlet is
// interrupted. Without this, Ctrl-C leaves a command or a server running,
// because each runs in its own process group so that it can be killed whole.
const cleanups = new Set<() => void>();

// Returns the function that stops tracking.
export function track(cleanup: () => void): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

// Last in, first out. A process is started after the directory it runs in,
// so it is killed before that directory is removed.
export function runCleanups(): void {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup();
    } catch {
      // One failed cleanup does not stop the others.
    }
  }
  cleanups.clear();
}
