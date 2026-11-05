export type {
  AzureAccess,
  AzureSession,
  ContextInfo,
  ContextStore,
  CredentialProvider,
  ResourceRef,
  ResourceResolver,
} from './contracts.js';
export { createContextStore, type ContextStoreDeps } from './context-store.js';
export { createAzureAccess, type AzureAccessDeps } from './azure-access.js';
export { createClientFactory, type ClientFactory } from './client-factory.js';
export {
  createResourceGraph,
  createResourceGraphScan,
  kqlString,
  DEFAULT_MAX_ROWS,
  HARD_MAX_ROWS,
  RESOURCE_GRAPH_CLIENT_KEY,
  type ResourceGraph,
  type ResourceGraphDeps,
  type ResourceGraphQueryClient,
  type ResourceGraphScan,
  type ResourceQueryOptions,
  type ResourceQueryResult,
  type ResourceScanOptions,
} from './resource-graph.js';
export {
  buildInventorySnapshot,
  createInventoryIndex,
  DEFAULT_INVENTORY_MAX_RESOURCES,
  INVENTORY_QUERY,
  INVENTORY_TTL_MS,
  type InventoryEntry,
  type InventoryFilter,
  type InventoryIndex,
  type InventoryIndexDeps,
  type InventoryIndexOptions,
  type InventorySnapshot,
  type InventoryStatus,
} from './inventory-index.js';
export { createResourceResolver, RESOLVER_TTL_MS, type ResolverDeps } from './resolver.js';
export { createPublicIpIndex, type PublicIpLookup } from './public-ip-index.js';
export {
  ARM_SCOPE,
  createCredentialManager,
  createDeviceCodeCredential,
  type CredentialFactory,
  type CredentialFactoryOptions,
  type CredentialManager,
  type CredentialManagerDeps,
  type LoginController,
  type LoginCredential,
  type AdminLoginState,
  type AdminLogins,
  type LoginState,
  type LoginStatus,
  type PendingLogin,
  type SessionChange,
  type StartLoginResult,
} from './credential-manager.js';
