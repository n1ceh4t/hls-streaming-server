/**
 * Simple async mutex for synchronizing asynchronous operations
 *
 * Usage:
 *   const mutex = new AsyncMutex();
 *   await mutex.runExclusive(async () => {
 *     // Critical section - only one execution at a time
 *   });
 */
export class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  /**
   * Acquire the lock
   */
  private async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  /**
   * Release the lock
   */
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Run a function exclusively (with mutex lock)
   * @param fn - Async function to run
   * @returns Result of the function
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Check if mutex is currently locked
   */
  isLocked(): boolean {
    return this.locked;
  }
}
