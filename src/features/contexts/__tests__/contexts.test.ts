import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  FAKE_ACCESS_TOKEN,
  FAKE_CONTEXTS,
  FAKE_USER_CODE,
  FAKE_VERIFICATION_URI,
  createFakeAzureAccess,
  createLoginRig,
  createTestToolContext,
  expectNoLeak,
  flushLogin,
  parseToolText,
  toolText,
  type LoginRig,
} from '../../../../test/helpers/index.js';
import { createAnonymizer } from '../../../core/anonymizer/index.js';
import { createAzureAccess, createContextStore, createPublicIpIndex } from '../../../core/azure/index.js';
import { contextIdAliases } from '../../../core/config/index.js';
import { executeTool, type ToolDefinition } from '../../../core/mcp/index.js';
import { createContextsFeature } from '../index.js';

const LOGIN_URL = 'http://127.0.0.1:8765/login';

function setup(): LoginRig & {
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const rig = createLoginRig();
  const feature = createContextsFeature({ logins: rig.manager, loginUrl: LOGIN_URL });
  const outputs: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const tool: ToolDefinition | undefined = feature.tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    const result = await executeTool(tool, args, rig.ctx);
    const text = toolText(result);
    outputs.push(text);
    // G1: nothing login-related ever reaches the AI.
    expectNoLeak(text);
    expect(text).not.toContain(FAKE_USER_CODE);
    expect(text).not.toContain(FAKE_ACCESS_TOKEN);
    expect(text).not.toContain(FAKE_VERIFICATION_URI);
    expect(text).not.toContain('devicelogin');
    return result;
  };
  return { ...rig, call };
}

describe('contexts feature', () => {
  it('exposes the five context tools', () => {
    const feature = createContextsFeature({ logins: createLoginRig().manager, loginUrl: LOGIN_URL });
    expect(feature.tools.map((t) => t.name)).toEqual([
      'list_contexts',
      'use_context',
      'login',
      'login_status',
      'logout',
    ]);
  });

  it('keeps the loopback login URL intact through executeTool (scrubber regression)', async () => {
    const rig = createLoginRig();
    const feature = createContextsFeature({ logins: rig.manager, loginUrl: LOGIN_URL });
    const tool = feature.tools.find((t) => t.name === 'login');
    if (tool === undefined) throw new Error('missing tool');
    // Anonymizer wired like main.ts: aliases, and a public IP index over Resource Graph.
    const azure = createFakeAzureAccess({
      inventory: {},
      resourceGraphRows: [
        {
          id: '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-web',
          name: 'pip-web',
          type: 'microsoft.network/publicipaddresses',
          ipAddress: '203.0.113.10',
        },
      ],
    });
    const publicIpIndex = createPublicIpIndex(azure.inventory);
    await publicIpIndex.refresh();
    const ctx = createTestToolContext({
      anonymizer: createAnonymizer({ aliases: contextIdAliases(FAKE_CONTEXTS), publicIpIndex }),
    });

    const result = await executeTool(tool, {}, ctx);
    expect(toolText(result)).toContain('http://127.0.0.1:8765/login');
    expect(parseToolText(result)).toEqual({ message: `Open ${LOGIN_URL} to sign in to context 'prod'.` });
  });

  it('lists contexts by alias only', async () => {
    const { call } = setup();
    expect(parseToolText(await call('list_contexts'))).toEqual({
      contexts: [
        { alias: 'prod', subscriptions: ['prod-app', 'prod-network'], loggedIn: false, active: true },
        { alias: 'lab', subscriptions: ['lab'], loggedIn: false, active: false },
      ],
    });
  });

  it('switches the active context', async () => {
    const { call, azure } = setup();
    expect(parseToolText(await call('use_context', { alias: 'lab' }))).toEqual({
      active: 'lab',
      loggedIn: false,
      message: "Context 'lab' is now active but not logged in. Run the login tool.",
    });
    expect(azure.contexts.active()).toBe('lab');
  });

  it('runs a full login / status / logout cycle without leaking the code or token', async () => {
    const { call, stub, azure, logs, manager } = setup();

    const login = await call('login');
    expect(login.isError).toBeUndefined();
    expect(parseToolText(login)).toEqual({ message: `Open ${LOGIN_URL} to sign in to context 'prod'.` });
    // The code really was captured server-side: the assertions above are not vacuous.
    expect(manager.loginPageState().pending[0]?.userCode).toBe(FAKE_USER_CODE);

    expect(parseToolText(await call('login_status', { alias: 'prod' }))).toEqual({
      contexts: [{ alias: 'prod', loggedIn: false, loginPending: true, loginFailed: false, active: true }],
    });
    expect(parseToolText(await call('login', { alias: 'prod' }))).toEqual({
      message: `Open ${LOGIN_URL} to sign in to context 'prod'.`,
    });

    stub.approve();
    await flushLogin();

    const status = parseToolText(await call('login_status')) as { contexts: unknown[] };
    expect(status.contexts).toEqual([
      {
        alias: 'prod',
        loggedIn: true,
        loginPending: false,
        loginFailed: false,
        expiresInMinutes: 30,
        active: true,
      },
      { alias: 'lab', loggedIn: false, loginPending: false, loginFailed: false, active: false },
    ]);
    expect(azure.session().contextAlias).toBe('prod');
    expect(parseToolText(await call('login', { alias: 'prod' }))).toMatchObject({
      message: expect.stringContaining('already logged in') as unknown,
    });
    await call('list_contexts');

    expect(parseToolText(await call('logout', { alias: 'prod' }))).toMatchObject({
      message: expect.stringContaining('logged out') as unknown,
    });
    expect(() => azure.session()).toThrow(expect.objectContaining({ code: 'NotLoggedIn' }));

    const allLogs = logs.join('\n');
    expect(allLogs).not.toContain(FAKE_USER_CODE);
    expect(allLogs).not.toContain(FAKE_ACCESS_TOKEN);
  });

  it('reports a failed login without the SDK error', async () => {
    const { call, stub } = setup();
    await call('login', { alias: 'lab' });
    stub.fail();
    await flushLogin();
    expect(parseToolText(await call('login_status', { alias: 'lab' }))).toEqual({
      contexts: [{ alias: 'lab', loggedIn: false, loginPending: false, loginFailed: true, active: false }],
    });
  });

  it.each([
    ['use_context', { alias: 'nope' }],
    ['login', { alias: 'nope' }],
    ['login_status', { alias: 'nope' }],
    ['logout', { alias: 'nope' }],
  ])('%s rejects an unknown alias with a clear AppError', async (name, args) => {
    const { call } = setup();
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      code: 'UnknownContext',
      message: 'Unknown context "nope". Known contexts: prod, lab.',
    });
  });

  it('login without alias and no active context fails with NoActiveContext', async () => {
    const rig = createLoginRig();
    // Two contexts, none selected.
    const store = createContextStore({ contexts: FAKE_CONTEXTS, isLoggedIn: () => false });
    const azure = createAzureAccess({
      contexts: FAKE_CONTEXTS,
      store,
      credentials: rig.manager,
      clients: rig.azure.clients,
    });
    const feature = createContextsFeature({ logins: rig.manager, loginUrl: LOGIN_URL });
    const tool = feature.tools.find((t) => t.name === 'login');
    if (tool === undefined) throw new Error('missing tool');
    const result = await executeTool(tool, {}, { ...rig.ctx, azure });
    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toMatchObject({ code: 'NoActiveContext' });
  });

  it('a session for a context that is not logged in is a clear NotLoggedIn AppError', () => {
    const { azure } = setup();
    expect(() => azure.session()).toThrow(
      expect.objectContaining({ code: 'NotLoggedIn', message: expect.stringContaining('login') as unknown }),
    );
  });
});
