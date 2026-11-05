import type { AzureAccess, ContextInfo, LoginController, LoginStatus } from '../../core/azure/index.js';

export interface ContextsDeps {
  /** Status and logout only: it cannot start a sign-in, and exposes no user code and no token. */
  readonly logins: LoginController;
}

export interface ContextsList {
  readonly contexts: readonly ContextInfo[];
}

export interface UseContextResult {
  readonly active: string;
  readonly loggedIn: boolean;
  readonly message: string;
}

export interface MessageResult {
  readonly message: string;
}

export interface LoginStatusResult {
  readonly contexts: readonly (LoginStatus & { readonly active: boolean })[];
}

export function listContexts(azure: AzureAccess): ContextsList {
  return { contexts: azure.contexts.list() };
}

export function useContext(azure: AzureAccess, deps: ContextsDeps, alias: string): UseContextResult {
  azure.contexts.use(alias);
  const { loggedIn } = deps.logins.status(alias);
  return {
    active: alias,
    loggedIn,
    message: loggedIn
      ? `Context '${alias}' is now active.`
      : `Context '${alias}' is now active but not logged in. Ask the user to run \`safe-azure login ${alias}\` in their own terminal.`,
  };
}

/**
 * A hint only: it does NOT start a device-code flow (ADR 0001 §2). Only the admin API, called by
 * the human's `safe-azure login` in a TTY, starts one and gets the code. Starting it here would let
 * an agent open a sign-in the human never asked for, and keep a live code waiting server-side.
 */
export function login(azure: AzureAccess, deps: ContextsDeps, alias?: string): MessageResult {
  const target = alias ?? azure.contexts.active();
  if (deps.logins.status(target).loggedIn) {
    return { message: `Context '${target}' is already logged in.` };
  }
  return { message: loginHint(target) };
}

export const loginHint = (alias: string): string =>
  `Ask the user to run \`safe-azure login ${alias}\` in their own terminal. The sign-in code is never shown here.`;

export function loginStatus(azure: AzureAccess, deps: ContextsDeps, alias?: string): LoginStatusResult {
  if (alias !== undefined) deps.logins.status(alias); // throws UnknownContext
  const contexts = azure.contexts.list().filter((c) => alias === undefined || c.alias === alias);
  return { contexts: contexts.map((c) => ({ ...deps.logins.status(c.alias), active: c.active })) };
}

export function logout(deps: ContextsDeps, alias: string): MessageResult {
  deps.logins.logout(alias);
  return { message: `Context '${alias}' is logged out. Its in-memory credential was dropped.` };
}
