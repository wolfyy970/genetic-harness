/**
 * Tests for the structured logger. Specifically: Errors and bigints must
 * serialize meaningfully (not as `{}` or via JSON.stringify default failure).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { logger } from '../src/shared/logger.js';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('logger error serialization', () => {
  it('serializes Error objects with message and stack instead of {}', () => {
    const err = new Error('boom');
    logger.error({ err }, 'something exploded');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain('something exploded');
    expect(line).toContain('boom');
    expect(line).not.toMatch(/"err":\s*\{\s*\}/);
  });

  it('serializes bigints as strings', () => {
    logger.info({ cpuNanos: 12345678901234567n }, 'nanos');
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain('12345678901234567');
  });

  it('still supports plain string-only calls', () => {
    logger.info('hello');
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain('hello');
    // No empty-meta blob.
    expect(line).not.toContain('{}');
  });
});
