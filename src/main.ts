import { readFileSync } from 'node:fs';
import { buildFeatures } from './app/features.js';
import { startHttpServer } from './app/server.js';
import { createAnonymizer, type AnonymizerConfig } from './core/anonymizer/index.js';
import { generateKeys, writeKeysFile } from './core/auth/index.js';
import {
  createAzureAccess,
  createContextStore,
  createCredentialManager,
  createPublicIpIndex,
  loadCredentialFactory,
  type AuthMode,
  type CredentialFactory,
} from './core/azure/index.js';
import { contextIdAliases, loadContexts, loadEnv } from './core/config/index.js';
import { AppError } from './core/errors/index.js';
import type { ToolContext } from './core/mcp/index.js';
import { createAuditLog, createLogger, silenceAzureSdkLogging } from './core/logging/index.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * A misconfigured AUTH_MODE=broker must say what is wrong. Its AppError messages are fixed text
 * (no path, no SDK output), so they are the one startup error printed as is.
 */
async function loadAuthFactory(mode: AuthMode): Promise<CredentialFactory> {
  try {
    return await loadCredentialFactory(mode);
  } catch (err) {
    if (err instanceof AppError) process.stderr.write(`Fatal: ${err.message}\n`);
    else process.stderr.write('Fatal: could not load the sign-in method (details withheld).\n');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  silenceAzureSdkLogging();
  const env = loadEnv();
  const contexts = await loadContexts(env.CONTEXTS_FILE);

  // Known IDs are shown to the AI by alias only.
  const anonymizerConfig: AnonymizerConfig = {
    aliases: contextIdAliases(contexts.contexts),
    safeTagKeys: contexts.safeTagKeys,
  };

  // Same rules as the tools, minus the public IP index: a log line must never trigger an Azure
  // call, so the logger shows every public IP as `public-ip-external-NNN`.
  const logAnonymizer = createAnonymizer(anonymizerConfig);
  const logger = createLogger(env.LOG_LEVEL, { anonymizer: logAnonymizer });
  // Same scrubbing as the logger. The file (if any) is opened now, so a bad path fails at startup.
  const audit = createAuditLog({
    mode: env.AUDIT_LOG,
    anonymizer: logAnonymizer,
    ...(env.AUDIT_LOG_FILE === undefined ? {} : { file: env.AUDIT_LOG_FILE }),
  });

  const credentials = createCredentialManager({
    contexts: contexts.contexts,
    logger,
    authMode: env.AUTH_MODE,
    factory: await loadAuthFactory(env.AUTH_MODE),
  });
  const store = createContextStore({
    contexts: contexts.contexts,
    isLoggedIn: (alias) => credentials.isLoggedIn(alias),
    ...(contexts.defaultContext === undefined ? {} : { initialActive: contexts.defaultContext }),
  });
  const azure = createAzureAccess({
    contexts: contexts.contexts,
    store,
    credentials,
    inventory: { maxResources: env.INVENTORY_MAX_RESOURCES },
    logger,
  });
  // The inventory index is memory only (#33): built right after login, dropped on logout.
  credentials.onSessionChange((alias, change) => {
    if (change === 'logout') azure.inventory.drop(alias);
    else void azure.inventory.refresh(alias);
  });

  // A view over the inventory snapshot: our own public IPs are shown by resource name.
  const publicIpIndex = createPublicIpIndex(azure.inventory);
  const anonymizer = createAnonymizer({ ...anonymizerConfig, publicIpIndex });
  const ctx: ToolContext = { anonymizer, logger, azure, audit };
  const features = buildFeatures({ version, logins: credentials });

  // New keys on every start (ADR 0001 §1). They go to the keys file and to the HTTP app, nowhere
  // else: never to the logger, the env, a tool or an error. A write failure is fatal (fail closed).
  const keys = generateKeys();
  writeKeysFile(env.KEYS_FILE, keys);

  logger.info('starting', {
    version,
    contexts: Object.keys(contexts.contexts).length,
    features: features.length,
    inventoryResource: env.INVENTORY_RESOURCE,
    audit: env.AUDIT_LOG,
    auth: env.AUTH_MODE,
  });
  const server = startHttpServer({
    host: env.HOST,
    port: env.PORT,
    version,
    features,
    ctx,
    logger,
    inventoryResource: env.INVENTORY_RESOURCE === 'on',
    keys,
    admin: { logins: credentials, contexts: store },
  });

  const shutdown = (): void => {
    logger.info('shutting down');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Node's default handlers print the error and its message, which for an Azure SDK error holds
// request URLs, tenant and subscription IDs (R5). Print a fixed line instead, then exit.
const crash = (): void => {
  process.stderr.write('Fatal: unexpected error (details withheld).\n');
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

main().catch(() => {
  process.stderr.write('Fatal: failed to start (details withheld).\n');
  process.exit(1);
});
