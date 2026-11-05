import type { IdentityPlugin, InteractiveBrowserCredentialNodeOptions } from '@azure/identity';
import { describe, expect, it, vi } from 'vitest';
import { FAKE_CONTEXTS } from '../../../../test/helpers/index.js';
import { createDeviceCodeCredential, loadCredentialFactory, type LoginCredential } from '../index.js';

const TENANT = FAKE_CONTEXTS.prod?.tenantId ?? '';

const fakeCredential: LoginCredential = {
  authenticate: () => Promise.resolve(),
  getToken: () => Promise.resolve(null),
};

const neverImport = () => Promise.reject(new Error('must not be imported'));

describe('loadCredentialFactory', () => {
  it('device-code (the default mode) returns the device-code factory and loads no broker', async () => {
    const importBroker = vi.fn(neverImport);
    for (const platform of ['linux', 'win32'] as const) {
      expect(await loadCredentialFactory('device-code', { platform, importBroker })).toBe(
        createDeviceCodeCredential,
      );
    }
    expect(importBroker).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin'] as const)('broker on %s fails before loading anything', async (platform) => {
    const importBroker = vi.fn(neverImport);
    await expect(loadCredentialFactory('broker', { platform, importBroker })).rejects.toMatchObject({
      name: 'AppError',
      code: 'BrokerUnsupportedPlatform',
      message: expect.stringContaining('AUTH_MODE=device-code') as unknown,
    });
    expect(importBroker).not.toHaveBeenCalled();
  });

  it('broker without @azure/identity-broker installed fails with a clear message, not the loader error', async () => {
    const loaderError = new Error(
      "Cannot find package '@azure/identity-broker' imported from C:\\Users\\someone\\secret\\dist\\x.js",
    );
    const err: unknown = await loadCredentialFactory('broker', {
      platform: 'win32',
      importBroker: () => Promise.reject(loaderError),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AppError', code: 'BrokerNotInstalled' });
    expect((err as Error).message).toContain('npm install @azure/identity-broker');
    expect((err as Error).message).not.toContain('someone');
    expect((err as Error).cause).toBeUndefined();
  });

  it('broker rejects a module without the WAM plugin', async () => {
    for (const mod of [undefined, null, {}, { nativeBrokerPlugin: 'nope' }]) {
      await expect(
        loadCredentialFactory('broker', { platform: 'win32', importBroker: () => Promise.resolve(mod) }),
      ).rejects.toMatchObject({ code: 'BrokerNotInstalled' });
    }
  });

  it('broker registers the WAM plugin and builds an in-memory, broker-enabled credential per tenant', async () => {
    const nativeBrokerPlugin: IdentityPlugin = () => undefined;
    const registered: IdentityPlugin[] = [];
    const seen: InteractiveBrowserCredentialNodeOptions[] = [];
    const factory = await loadCredentialFactory('broker', {
      platform: 'win32',
      importBroker: () => Promise.resolve({ nativeBrokerPlugin }),
      useIdentityPlugin: (plugin) => registered.push(plugin),
      newCredential: (options) => {
        seen.push(options);
        return fakeCredential;
      },
    });
    expect(registered).toEqual([nativeBrokerPlugin]);

    const onDeviceCode = vi.fn();
    expect(factory({ tenantId: TENANT, onDeviceCode })).toBe(fakeCredential);
    expect(onDeviceCode).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    const options = seen[0];
    expect(options).toMatchObject({
      tenantId: TENANT,
      disableAutomaticAuthentication: true,
      brokerOptions: { enabled: true, useDefaultBrokerAccount: false },
    });
    expect(options?.brokerOptions?.parentWindowHandle).toBeInstanceOf(Uint8Array);
    // R8: no on-disk MSAL cache.
    expect(options).not.toHaveProperty('tokenCachePersistenceOptions');
  });
});
