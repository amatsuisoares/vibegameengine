export type LogLevel = 'log' | 'warn' | 'error';

export interface LogEntry {
  seq: number;
  frame: number;
  level: LogLevel;
  message: string;
  source?: string;
}

/** Game console: everything the runtime reports lands here so the agent can read it. */
export class GameConsole {
  private entries: LogEntry[] = [];
  private seq = 0;
  frame = 0;

  constructor(private readonly capacity = 1000, private readonly mirror?: (e: LogEntry) => void) {}

  log(message: string, source?: string) {
    this.push('log', message, source);
  }
  warn(message: string, source?: string) {
    this.push('warn', message, source);
  }
  error(message: string, source?: string) {
    this.push('error', message, source);
  }

  /** Entries with seq > since (use the last seq you saw to read incrementally). */
  read(since = 0, level?: LogLevel): LogEntry[] {
    return this.entries.filter((e) => e.seq > since && (!level || e.level === level));
  }

  get lastSeq() {
    return this.seq;
  }

  clear() {
    this.entries = [];
  }

  private push(level: LogLevel, message: string, source?: string) {
    const entry: LogEntry = { seq: ++this.seq, frame: this.frame, level, message, source };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    this.mirror?.(entry);
  }
}
