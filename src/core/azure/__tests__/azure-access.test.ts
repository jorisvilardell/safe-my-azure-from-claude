import { describe, expect, it } from 'vitest';
import { FAKE_CONTEXTS, createFakeTokenCredential, expectNoLeak } from '../../../../test/helpers/index.js';
import { AppError } from '../../errors/index.js';
import { createAzureAccess, createContextStore, type CredentialProvider } from '../index.js';

function expectAppError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  expect.fail(`expected AppError ${code}`);
}

describe('createContextStore', () => {
  const isLoggedIn = (alias: string): boolean => alias === 'lab';

  it('lists aliases and flags only, never IDs', () => {
    const store = createContextStore({ contexts: FAKE_CONTEXTS, isLoggedIn, initialActive: 'prod' });
    const list = store.list();

    expect(list).toEqual([
      { alias: 'prod', subscriptions: ['prod-app', 'prod-network'], loggedIn: false, active: true },
      { alias: 'lab', subscriptions: ['lab'], loggedIn: true, active: false },
    ]);
    expectNoLeak(list);
  });

  it('has no active context by default when several are declared', () => {
    const store = createContextStore({ contexts: FAKE_CONTEXTS, isLoggedIn });
    expectAppError(() => store.active(), 'NoActiveContext');
    expect(store.list().every((c) => !c.active)).toBe(true);
  });

  it('activates the only declared context by default', () => {
    const { lab } = FAKE_CONTEXTS;
    if (lab === undefined) throw new Error('missing fixture');
    const store = createContextStore({ contexts: { lab }, isLoggedIn });
    expect(store.active()).toBe('lab');
  });

  it('switches context with use()', () => {
    const store = createContextStore({ contexts: FAKE_CONTEXTS, isLoggedIn });
    store.use('lab');
    expect(store.active()).toBe('lab');
  });

  it('rejects unknown aliases, including prototype keys', () => {
    const store = createContextStore({ contexts: FAKE_CONTEXTS, isLoggedIn });
    expectAppError(() => {
      store.use('nope');
    }, 'UnknownContext');
    expectAppError(() => {
      store.use('constructor');
    }, 'UnknownContext');
    expectAppError(
      () => createContextStore({ contexts: FAKE_CONTEXTS, isLoggedIn, initialActive: 'nope' }),
      'UnknownContext',
    );
  });

  it('handles an empty config', () => {
    const store = createContextStore({ contexts: {}, isLoggedIn });
    expect(store.list()).toEqual([]);
    expectAppError(() => store.active(), 'NoActiveContext');
  });
});

describe('createAzureAccess', () => {
  const credential = createFakeTokenCredential();
  const credentials: CredentialProvider = {
    isLoggedIn: (alias) => alias === 'prod',
    getCredential(alias) {
      if (alias !== 'prod') throw new AppError('NotLoggedIn', 'not logged in');
      return credential;
    },
  };
  const resolver = { resolve: () => Promise.resolve('unused') };

  function build(initialActive?: string): ReturnType<typeof createAzureAccess> {
    const store = createContextStore({
      contexts: FAKE_CONTEXTS,
      isLoggedIn: (alias) => credentials.isLoggedIn(alias),
      ...(initialActive === undefined ? {} : { initialActive }),
    });
    return createAzureAccess({ contexts: FAKE_CONTEXTS, store, credentials, resolver });
  }

  it('builds a session for the active, logged-in context', () => {
    const session = build('prod').session();

    expect(session.contextAlias).toBe('prod');
    expect(session.credential).toBe(credential);
    expect(session.subscriptionIds()).toEqual([
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    ]);
    expect(session.subscriptionId('prod-network')).toBe('00000000-0000-0000-0000-000000000002');
  });

  it('only resolves subscriptions of the active context', () => {
    const session = build('prod').session();
    expectAppError(() => session.subscriptionId('lab'), 'UnknownSubscription');
    expectAppError(() => session.subscriptionId('toString'), 'UnknownSubscription');
  });

  it('fails without an active context', () => {
    expectAppError(() => build().session(), 'NoActiveContext');
  });

  it('fails when the active context is not logged in', () => {
    expectAppError(() => build('lab').session(), 'NotLoggedIn');
  });
});
