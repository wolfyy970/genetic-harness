/**
 * Tests for src/server/auth.ts: bearer-token middleware + bind-host policy.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import {
  isAuthorized,
  setAuthToken,
  validateBindHost,
  getAuthToken,
} from '../src/server/auth.js';

afterEach(() => setAuthToken(null));

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = headers;
  return req;
}

describe('isAuthorized', () => {
  it('returns true when no token is configured', () => {
    setAuthToken(null);
    expect(isAuthorized(makeReq())).toBe(true);
  });

  it('returns false when token is set but no header is sent', () => {
    setAuthToken('s3cr3t-1234567890ab');
    expect(isAuthorized(makeReq())).toBe(false);
  });

  it('returns false on wrong scheme', () => {
    setAuthToken('s3cr3t-1234567890ab');
    expect(isAuthorized(makeReq({ authorization: 'Basic abc' }))).toBe(false);
  });

  it('returns false on wrong token', () => {
    setAuthToken('s3cr3t-1234567890ab');
    expect(
      isAuthorized(makeReq({ authorization: 'Bearer wrong-1234567890ab' })),
    ).toBe(false);
  });

  it('returns true on matching token', () => {
    setAuthToken('s3cr3t-1234567890ab');
    expect(
      isAuthorized(makeReq({ authorization: 'Bearer s3cr3t-1234567890ab' })),
    ).toBe(true);
  });

  it('returns false when token length differs (constant-time guard short-circuit)', () => {
    setAuthToken('s3cr3t-1234567890ab');
    expect(
      isAuthorized(makeReq({ authorization: 'Bearer short' })),
    ).toBe(false);
  });
});

describe('setAuthToken / getAuthToken', () => {
  it('treats empty string as null', () => {
    setAuthToken('');
    expect(getAuthToken()).toBeNull();
  });

  it('round-trips a non-empty token', () => {
    setAuthToken('foo123');
    expect(getAuthToken()).toBe('foo123');
  });
});

describe('validateBindHost', () => {
  it('accepts loopback regardless of token', () => {
    expect(validateBindHost('127.0.0.1', null)).toBeNull();
    expect(validateBindHost('localhost', null)).toBeNull();
    expect(validateBindHost('::1', null)).toBeNull();
  });

  it('refuses 0.0.0.0 with no token', () => {
    expect(validateBindHost('0.0.0.0', null)).toMatch(/HARNESS_TOKEN/);
  });

  it('refuses 0.0.0.0 with a too-short token', () => {
    expect(validateBindHost('0.0.0.0', 'short')).toMatch(/HARNESS_TOKEN/);
  });

  it('accepts 0.0.0.0 with a sufficiently long token', () => {
    expect(validateBindHost('0.0.0.0', '1234567890abcdef')).toBeNull();
  });

  it('refuses arbitrary external host without a token', () => {
    expect(validateBindHost('192.168.1.10', null)).toMatch(/HARNESS_TOKEN/);
  });
});
