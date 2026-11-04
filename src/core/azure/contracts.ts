import type { TokenCredential } from '@azure/core-auth';
import type { ClientFactory } from './client-factory.js';
import type { InventoryIndex } from './inventory-index.js';
import type { ResourceGraph } from './resource-graph.js';

/**
 * What the AI may learn about a context: aliases and flags only.
 * Real tenant/subscription IDs never appear here (AGENTS.md G2).
 */
export interface ContextInfo {
  readonly alias: string;
  /** Subscription ALIASES declared for this context. */
  readonly subscriptions: readonly string[];
  readonly loggedIn: boolean;
  readonly active: boolean;
}

/** The contexts declared in contexts.yaml, plus which one is active. */
export interface ContextStore {
  list(): readonly ContextInfo[];
  /** Alias of the active context. Throws `AppError('NoActiveContext')`. */
  active(): string;
  /** Switches the active context. Throws `AppError('UnknownContext')`. */
  use(alias: string): void;
}

/** Holds the in-memory credentials, one per context (AGENTS.md R8). */
export interface CredentialProvider {
  isLoggedIn(contextAlias: string): boolean;
  /** Throws `AppError('NotLoggedIn')`. */
  getCredential(contextAlias: string): TokenCredential;
}

/**
 * Everything a service needs to call Azure for the active context.
 * Server-side only: never return any of it from a tool.
 */
export interface AzureSession {
  readonly contextAlias: string;
  readonly credential: TokenCredential;
  /** Real subscription IDs of the active context, in declaration order. */
  subscriptionIds(): readonly string[];
  /** Real subscription ID for an alias of the active context. Throws `AppError('UnknownSubscription')`. */
  subscriptionId(alias: string): string;
}

/** A resource as the AI names it: aliases and names, never IDs (AGENTS.md feature checklist #4). */
export interface ResourceRef {
  /** Subscription ALIAS. Omitted means "search every subscription of the active context". */
  readonly subscription?: string;
  readonly resourceGroup?: string;
  readonly name: string;
  /** ARM type, e.g. `Microsoft.Compute/virtualMachines`. */
  readonly type?: string;
}

export interface ResourceResolver {
  /**
   * Resolves a ref to its ARM resource ID, within the active context.
   * Throws `AppError('ResourceNotFound')` or `AppError('AmbiguousResource')`.
   */
  resolve(ref: ResourceRef): Promise<string>;
}

/**
 * The single Azure entry point handed to tools through `ToolContext.azure`.
 * One instance per server: every feature shares its Resource Graph client, SDK client cache
 * and resolver. Server-side only: never return any of it from a tool.
 */
export interface AzureAccess {
  readonly contexts: ContextStore;
  /** Throws `AppError('NoActiveContext')` or `AppError('NotLoggedIn')`. */
  session(): AzureSession;
  /** Resource name → ARM ID, within the active context. */
  readonly resolver: ResourceResolver;
  /** Read-only Resource Graph queries, scoped to the active context's subscriptions. */
  readonly resourceGraph: ResourceGraph;
  /**
   * In-memory inventory snapshot of the active context (#33), the single source for the resolver,
   * the public IP index and the inventory tools. `current()` is `undefined` when it is not fresh:
   * then query Resource Graph live. Memory only, dropped on logout. Holds ARM IDs: server-side only.
   */
  readonly inventory: InventoryIndex;
  /** Per-context cache of Azure SDK clients. Build every SDK client through it. */
  readonly clients: ClientFactory;
}
