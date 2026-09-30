import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Retries briefly on Windows sharing violations (file watchers and antivirus hold files open). */
function withRetry<T>(fn: () => T, attempts = 10): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || !code || !RETRYABLE.has(code)) throw err;
      const until = Date.now() + 10 * i;
      while (Date.now() < until) {
        // Short synchronous back-off; the store's API is synchronous on purpose.
      }
    }
  }
}

/**
 * Writes via a temporary file in the same directory and a rename, so readers
 * (the dev server, the runtime) never observe a half-written file.
 */
export function writeFileAtomic(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    withRetry(() => renameSync(tmp, file));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function removeFile(file: string) {
  withRetry(() => rmSync(file, { force: true }));
}
