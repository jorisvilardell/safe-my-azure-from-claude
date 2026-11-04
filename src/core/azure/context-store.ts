import type { AzureContext } from '../config/index.js';
import { AppError } from '../errors/index.js';
import type { ContextInfo, ContextStore } from './contracts.js';

export interface ContextStoreDeps {
  readonly contexts: Readonly<Record<string, AzureContext>>;
  readonly isLoggedIn: (contextAlias: string) => boolean;
  /** Initially active context. Defaults to the only context when exactly one is declared. */
  readonly initialActive?: string;
}

/** In-memory store of the declared contexts. The active alias lives for the server process. */
export function createContextStore(deps: ContextStoreDeps): ContextStore {
  const aliases = Object.keys(deps.contexts);
  const assertKnown = (alias: string): void => {
    if (!Object.hasOwn(deps.contexts, alias)) {
      throw new AppError(
        'UnknownContext',
        `Unknown context "${alias}". Known contexts: ${aliases.join(', ') || '(none)'}.`,
      );
    }
  };

  if (deps.initialActive !== undefined) assertKnown(deps.initialActive);
  let active: string | undefined = deps.initialActive ?? (aliases.length === 1 ? aliases[0] : undefined);

  return {
    list(): readonly ContextInfo[] {
      return aliases.map((alias) => ({
        alias,
        subscriptions: Object.keys(deps.contexts[alias]?.subscriptions ?? {}),
        loggedIn: deps.isLoggedIn(alias),
        active: alias === active,
      }));
    },
    active(): string {
      if (active === undefined) {
        throw new AppError('NoActiveContext', 'No active context. Select one with the context tools first.');
      }
      return active;
    },
    use(alias: string): void {
      assertKnown(alias);
      active = alias;
    },
  };
}
