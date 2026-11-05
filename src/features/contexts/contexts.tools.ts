import { defineTool, type ToolDefinition } from '../../core/mcp/index.js';
import {
  ListContextsInput,
  LoginInput,
  LoginStatusInput,
  LogoutInput,
  UseContextInput,
} from './contexts.schemas.js';
import {
  listContexts,
  login,
  loginStatus,
  logout,
  useContext,
  type ContextsDeps,
} from './contexts.service.js';

export function createContextsTools(deps: ContextsDeps): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'list_contexts',
      title: 'List contexts',
      description:
        'Lists the Azure contexts (tenant aliases) declared on the server, with their subscription aliases, ' +
        'which one is active and which ones are logged in.',
      inputSchema: ListContextsInput,
      handler: (_args, ctx) => Promise.resolve(listContexts(ctx.azure)),
    }),
    defineTool({
      name: 'use_context',
      title: 'Use context',
      description: 'Switches the active Azure context. Every other tool then works on that context.',
      inputSchema: UseContextInput,
      handler: ({ alias }, ctx) => Promise.resolve(useContext(ctx.azure, deps, alias)),
    }),
    defineTool({
      name: 'login',
      title: 'Login',
      description:
        'Tells you how the HUMAN user signs in to a context (default: the active one): they run ' +
        '`safe-azure login <alias>` in their own terminal. This tool does not start a sign-in and never ' +
        'returns a code. Relay the message, then check login_status.',
      inputSchema: LoginInput,
      handler: ({ alias }, ctx) => Promise.resolve(login(ctx.azure, deps, alias)),
    }),
    defineTool({
      name: 'login_status',
      title: 'Login status',
      description:
        'Shows, per context, whether it is logged in, whether a sign-in is pending or failed, and how many ' +
        'minutes the current access token has left.',
      inputSchema: LoginStatusInput,
      handler: ({ alias }, ctx) => Promise.resolve(loginStatus(ctx.azure, deps, alias)),
    }),
    defineTool({
      name: 'logout',
      title: 'Logout',
      description: 'Drops the in-memory credential of a context. A new login is needed afterwards.',
      inputSchema: LogoutInput,
      handler: ({ alias }) => Promise.resolve(logout(deps, alias)),
    }),
  ] as const;
}
