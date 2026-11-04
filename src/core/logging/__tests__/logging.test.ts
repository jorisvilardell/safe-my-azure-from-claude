import { createClientLogger, getLogLevel, setLogLevel } from '@azure/logger';
import {
  createClientLogger as createTypeSpecClientLogger,
  setLogLevel as setTypeSpecLogLevel,
} from '@typespec/ts-http-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_ACCESS_TOKEN, FAKE_CONTEXTS, expectNoLeak } from '../../../../test/helpers/index.js';
import { createAnonymizer } from '../../anonymizer/index.js';
import { contextIdAliases } from '../../config/index.js';
import { createLogger, silenceAzureSdkLogging } from '../index.js';

const SUB = '00000000-0000-0000-0000-000000000001';

describe('createLogger', () => {
  it('scrubs every line with the given anonymizer (aliases included)', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', {
      anonymizer: createAnonymizer({ aliases: contextIdAliases(FAKE_CONTEXTS) }),
      write: (line) => lines.push(line),
    });
    logger.info('call', { scope: `/subscriptions/${SUB}`, token: FAKE_ACCESS_TOKEN, tags: { owner: 'x' } });

    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ scope: 'sub:prod-app', token: '[REDACTED]', tags: { owner: '[masked]' } });
    expectNoLeak(lines);
  });

  it('defaults to the most restrictive anonymizer', () => {
    const lines: string[] = [];
    createLogger('info', { write: (line) => lines.push(line) }).warn('x', { sub: SUB });
    expect(lines[0]).not.toContain(SUB);
  });

  it('drops lines below the level', () => {
    const lines: string[] = [];
    createLogger('warn', { write: (line) => lines.push(line) }).info('hidden');
    expect(lines).toEqual([]);
  });
});

describe('silenceAzureSdkLogging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps Azure SDK logs (identity, MSAL, HTTP pipeline) off stderr, even when re-enabled', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    silenceAzureSdkLogging();
    expect(getLogLevel()).toBeUndefined();

    // As if AZURE_LOG_LEVEL / TYPESPEC_RUNTIME_LOG_LEVEL=verbose had been set.
    setLogLevel('verbose');
    setTypeSpecLogLevel('verbose');
    createClientLogger('identity').verbose(`token ${FAKE_ACCESS_TOKEN} for /subscriptions/${SUB}`);
    createTypeSpecClientLogger('ts-http-runtime').info(`request to /subscriptions/${SUB}`);
    setLogLevel();
    setTypeSpecLogLevel();

    expect(stderr).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
