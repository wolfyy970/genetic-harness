/**
 * Structured logger matching pino's (meta, message) calling convention.
 * Outputs human-readable log lines with optional JSON metadata.
 *
 * Usage:
 *   logger.info('simple message')
 *   logger.info({ shipId: 'ship-0' }, 'message with meta')
 *   logger.debug({ key: 'val' }, 'debug message')  // only shown when DEBUG=1
 *
 * @module logger
 */

// =============================================================================
// Type aliases
// =============================================================================

/** Log severity levels for structured logging. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A single structured log entry with timestamp, level, message, and optional metadata. */
interface LogEntry {
  /** ISO 8601 timestamp of when the entry was created */
  timestamp: string;
  /** Log severity level */
  level: LogLevel;
  /** Main message string */
  message: string;
  /** Optional key-value metadata (printed as compact JSON) */
  meta?: Record<string, unknown>;
}

// =============================================================================
// Internal functions
// =============================================================================

/**
 * Format a LogEntry into a human-readable string.
 * Output: [ISO-TIMESTAMP] LEVEL message {meta}
 *
 * @param entry - The log entry to format
 * @returns A formatted log line string
 */
function format(entry: LogEntry): string {
  const meta = entry.meta ? ' ' + JSON.stringify(entry.meta) : '';
  return `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.message}${meta}`;
}

/**
 * Core log dispatch function. Supports both calling conventions:
 *   logger.info('simple message')
 *   logger.info({ key: 'value' }, 'message with meta')
 *
 * Routes to the appropriate console method (log/warn/error) based on level.
 * Debug messages only print when the `DEBUG` environment variable is set.
 *
 * @param level   - Log severity level
 * @param meta    - Either a string (message) or a metadata object
 * @param msg     - Message string (required if meta is an object)
 */
function log(level: LogLevel, meta: Record<string, unknown> | string, msg?: string): void {
  let message: string;
  let entryMeta: Record<string, unknown> | undefined;

  if (typeof meta === 'string') {
    message = meta;
    entryMeta = undefined;
  } else {
    entryMeta = meta as Record<string, unknown>;
    message = msg || '';
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    meta: entryMeta,
  };

  const formatted = format(entry);

  switch (level) {
    case 'debug':
      if (process.env.DEBUG) console.log(formatted);
      break;
    case 'info':
      console.log(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'error':
      console.error(formatted);
      break;
  }
}

// =============================================================================
// Public API — logger
// =============================================================================

/**
 * The structured logger instance. Use for all logging in the genetic harness.
 *
 * Methods support two calling conventions:
 *   - `logger.info('message')` — plain text
 *   - `logger.info({ key: 'val' }, 'message')` — with metadata
 *
 * `.debug()` only outputs when the `DEBUG` environment variable is set.
 */
export const logger = {
  /**
   * Log a debug-level message. Only prints when `DEBUG` env var is set.
   * @param meta - Metadata object or message string
   * @param msg  - Message string (required if meta is an object)
   */
  debug: (meta: Record<string, unknown> | string, msg?: string) => log('debug', meta, msg),
  /**
   * Log an info-level message. Always prints.
   * @param meta - Metadata object or message string
   * @param msg  - Message string (required if meta is an object)
   */
  info: (meta: Record<string, unknown> | string, msg?: string) => log('info', meta, msg),
  /**
   * Log a warning-level message. Always prints.
   * @param meta - Metadata object or message string
   * @param msg  - Message string (required if meta is an object)
   */
  warn: (meta: Record<string, unknown> | string, msg?: string) => log('warn', meta, msg),
  /**
   * Log an error-level message. Always prints.
   * @param meta - Metadata object or message string
   * @param msg  - Message string (required if meta is an object)
   */
  error: (meta: Record<string, unknown> | string, msg?: string) => log('error', meta, msg),
};

export default logger;
