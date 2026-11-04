import { describe, expect, it } from 'vitest';
import { AppError, sanitizeError } from '../index.js';

describe('sanitizeError', () => {
  it('keeps messages of AppError', () => {
    expect(sanitizeError(new AppError('NotLoggedIn', 'Run login first.'))).toEqual({
      code: 'NotLoggedIn',
      message: 'Run login first.',
    });
  });

  it('drops messages of foreign errors (may contain ids/urls)', () => {
    const azureError = Object.assign(
      new Error('GET https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000001 failed'),
      { statusCode: 403, code: 'AuthorizationFailed' },
    );
    const safe = sanitizeError(azureError);
    expect(safe.code).toBe('AuthorizationFailed');
    expect(safe.message).toContain('HTTP 403');
    expect(safe.message).not.toContain('subscriptions');
  });

  it('handles non-error throwables', () => {
    expect(sanitizeError('boom').code).toBe('InternalError');
  });
});
