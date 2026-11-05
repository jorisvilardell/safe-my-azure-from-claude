import { describe, expect, it } from 'vitest';
import {
  FAKE_ACCESS_TOKEN,
  FAKE_CONTEXTS,
  FAKE_USER_CODE,
  FAKE_VERIFICATION_URI,
  createStubLogin,
  flushLogin,
} from '../../../../test/helpers/index.js';
import { createLogger } from '../../logging/index.js';
import { ARM_SCOPE, createCredentialManager } from '../index.js';

function setup(now?: () => number) {
  const stub = createStubLogin();
  const logs: string[] = [];
  const manager = createCredentialManager({
    contexts: FAKE_CONTEXTS,
    logger: createLogger('debug', { write: (line) => logs.push(line) }),
    factory: stub.factory,
    ...(now === undefined ? {} : { now }),
  });
  return { stub, logs, manager };
}

describe('createCredentialManager', () => {
  it('starts not logged in and rejects getCredential with NotLoggedIn', () => {
    const { manager } = setup();
    expect(manager.isLoggedIn('prod')).toBe(false);
    expect(() => manager.getCredential('prod')).toThrow(expect.objectContaining({ code: 'NotLoggedIn' }));
    expect(manager.status('prod')).toEqual({
      alias: 'prod',
      loggedIn: false,
      loginPending: false,
      loginFailed: false,
    });
  });

  it('rejects unknown aliases with UnknownContext', () => {
    const { manager } = setup();
    for (const call of [
      () => manager.startLogin('nope'),
      () => manager.status('nope'),
      () => {
        manager.logout('nope');
      },
      () => manager.getCredential('nope'),
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: 'UnknownContext' }));
    }
  });

  it('creates one credential per context, with that context tenant', () => {
    const { stub, manager } = setup();
    manager.startLogin('prod');
    manager.startLogin('lab');
    expect(stub.created).toEqual([FAKE_CONTEXTS.prod?.tenantId, FAKE_CONTEXTS.lab?.tenantId]);
  });

  it('logs in and serves tokens from the CAE cache the Azure SDK pipelines use', async () => {
    const seen: { call: string; enableCae: unknown }[] = [];
    const manager = createCredentialManager({
      contexts: FAKE_CONTEXTS,
      logger: createLogger('error', { write: () => undefined }),
      factory: () => ({
        authenticate: (_scopes, options) => {
          seen.push({ call: 'authenticate', enableCae: options?.enableCae });
          return Promise.resolve();
        },
        getToken: (_scopes, options) => {
          seen.push({ call: 'getToken', enableCae: options?.enableCae });
          return Promise.resolve({ token: FAKE_ACCESS_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 });
        },
      }),
    });
    manager.startLogin('prod');
    await flushLogin();
    await manager.getCredential('prod').getToken(ARM_SCOPE, { enableCae: false });
    expect(seen.map((s) => s.call)).toEqual(['authenticate', 'getToken', 'getToken']);
    expect(seen.every((s) => s.enableCae === true)).toBe(true);
  });

  it('captures the device code for the login page only, then logs in on approval', async () => {
    const { stub, manager, logs } = setup();
    expect(manager.startLogin('prod')).toBe('started');
    expect(manager.startLogin('prod')).toBe('already-pending');

    const [pending] = manager.loginPageState().pending;
    expect(pending).toMatchObject({
      alias: 'prod',
      state: 'waiting',
      userCode: FAKE_USER_CODE,
      verificationUri: FAKE_VERIFICATION_URI,
    });
    expect(manager.status('prod')).toMatchObject({ loggedIn: false, loginPending: true });

    stub.approve();
    await flushLogin();

    expect(manager.isLoggedIn('prod')).toBe(true);
    expect(manager.status('prod')).toEqual({
      alias: 'prod',
      loggedIn: true,
      loginPending: false,
      loginFailed: false,
      expiresInMinutes: 30,
    });
    expect(manager.loginPageState().pending).toEqual([]);
    expect(manager.loginPageState().loggedIn.map((c) => c.alias)).toEqual(['prod']);
    expect(manager.startLogin('prod')).toBe('already-logged-in');

    const token = await manager.getCredential('prod').getToken(ARM_SCOPE);
    expect(token?.token).toBe(FAKE_ACCESS_TOKEN);
    expect(logs.join('\n')).not.toContain(FAKE_USER_CODE);
    expect(logs.join('\n')).not.toContain(FAKE_ACCESS_TOKEN);
  });

  it('marks a failed login, without logging the SDK error, and allows a retry', async () => {
    const { stub, manager, logs } = setup();
    manager.startLogin('lab');
    stub.fail();
    await flushLogin();

    expect(manager.status('lab')).toMatchObject({ loggedIn: false, loginPending: false, loginFailed: true });
    expect(manager.loginPageState().pending).toEqual([{ alias: 'lab', state: 'failed' }]);
    expect(logs.join('\n')).not.toContain(FAKE_USER_CODE);
    expect(logs.join('\n')).not.toContain('AADSTS');

    expect(manager.startLogin('lab')).toBe('started');
  });

  it('reports an expired device code as expired', async () => {
    let t = 1_000_000;
    const { stub, manager } = setup(() => t);
    manager.startLogin('prod');
    t += 16 * 60_000;
    expect(manager.startLogin('prod')).toBe('started'); // stale code: restart
    stub.fail(); // the first (aborted) flow
    stub.fail(); // the second one, after its code expired too
    t += 16 * 60_000;
    await flushLogin();
    expect(manager.loginPageState().pending).toEqual([{ alias: 'prod', state: 'expired' }]);
  });

  it('logout drops the credential and aborts a pending login', async () => {
    const { stub, manager } = setup();
    manager.startLogin('prod');
    stub.approve();
    await flushLogin();
    manager.logout('prod');
    expect(manager.isLoggedIn('prod')).toBe(false);
    expect(() => manager.getCredential('prod')).toThrow(expect.objectContaining({ code: 'NotLoggedIn' }));

    manager.startLogin('lab');
    manager.logout('lab');
    await flushLogin();
    expect(manager.loginPageState()).toEqual({ pending: [], loggedIn: [] });
    stub.approve(); // a late approval of the aborted flow must not log it in
    await flushLogin();
    expect(manager.isLoggedIn('lab')).toBe(false);
  });

  it('turns an expired session into a clean NotLoggedIn AppError', async () => {
    const { stub, manager } = setup();
    manager.startLogin('prod');
    stub.approve();
    await flushLogin();
    const credential = manager.getCredential('prod');

    stub.expireSession();
    const err: unknown = await credential.getToken(ARM_SCOPE).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AppError', code: 'NotLoggedIn' });
    expect((err as Error).message).not.toContain(FAKE_USER_CODE);
    expect(manager.isLoggedIn('prod')).toBe(false);
  });

  it('tells listeners about login, logout and expired sessions, and survives a failing listener', async () => {
    const { stub, manager, logs } = setup();
    const changes: string[] = [];
    manager.onSessionChange(() => {
      throw new Error('listener bug');
    });
    manager.onSessionChange((alias, change) => changes.push(`${alias}:${change}`));

    manager.startLogin('prod');
    stub.approve();
    await flushLogin();
    expect(manager.isLoggedIn('prod')).toBe(true);
    manager.logout('prod');
    manager.logout('prod'); // nothing to log out: no event

    manager.startLogin('lab');
    stub.approve();
    await flushLogin();
    stub.expireSession();
    const credential = manager.getCredential('lab');
    await credential.getToken(ARM_SCOPE).catch(() => undefined);
    await credential.getToken(ARM_SCOPE).catch(() => undefined);

    expect(changes).toEqual(['prod:login', 'prod:logout', 'lab:login', 'lab:logout']);
    expect(logs.join('\n')).toContain('session listener failed');
    expect(logs.join('\n')).not.toContain('listener bug');
  });
});
