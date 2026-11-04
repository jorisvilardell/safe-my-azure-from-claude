import type { AzureAccess, ContextInfo, LoginController, LoginStatus } from '../../core/azure/index.js';

export interface ContextsDeps {
  /** Login lifecycle only: this interface exposes no user code and no token. */
  readonly logins: LoginController;
  /** Absolute URL of the /login page, built from config (never from request headers). */
  readonly loginUrl: string;
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
      : `Context '${alias}' is now active but not logged in. Run the login tool.`,
  };
}

/**
 * Starts the device-code flow. The user code is shown ONLY on the /login page:
 * this result is a fixed message that never carries the code (AGENTS.md G1, R1).
 */
export function login(azure: AzureAccess, deps: ContextsDeps, alias?: string): MessageResult {
  const target = alias ?? azure.contexts.active();
  if (deps.logins.startLogin(target) === 'already-logged-in') {
    return { message: `Context '${target}' is already logged in. Run logout first to sign in again.` };
  }
  return { message: `Open ${deps.loginUrl} to sign in to context '${target}'.` };
}

export function loginStatus(azure: AzureAccess, deps: ContextsDeps, alias?: string): LoginStatusResult {
  if (alias !== undefined) deps.logins.status(alias); // throws UnknownContext
  const contexts = azure.contexts.list().filter((c) => alias === undefined || c.alias === alias);
  return { contexts: contexts.map((c) => ({ ...deps.logins.status(c.alias), active: c.active })) };
}

export function logout(deps: ContextsDeps, alias: string): MessageResult {
  deps.logins.logout(alias);
  return { message: `Context '${alias}' is logged out. Its in-memory credential was dropped.` };
}
