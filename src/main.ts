import { readFileSync } from 'node:fs';
import { buildFeatures } from './app/features.js';
import { startHttpServer } from './app/server.js';
import { createAnonymizer, type AnonymizerConfig } from './core/anonymizer/index.js';
import {
  createAzureAccess,
  createContextStore,
  createCredentialManager,
  createPublicIpIndex,
} from './core/azure/index.js';
import { contextIdAliases, loadContexts, loadEnv, loginPageUrl } from './core/config/index.js';
import type { ToolContext } from './core/mcp/index.js';
import { createLogger, silenceAzureSdkLogging } from './core/logging/index.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

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
  const logger = createLogger(env.LOG_LEVEL, { anonymizer: createAnonymizer(anonymizerConfig) });

  const credentials = createCredentialManager({ contexts: contexts.contexts, logger });
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
  const ctx: ToolContext = { anonymizer, logger, azure };
  const features = buildFeatures({ version, logins: credentials, loginUrl: loginPageUrl(env) });

  logger.info('starting', {
    version,
    contexts: Object.keys(contexts.contexts).length,
    features: features.length,
    inventoryResource: env.INVENTORY_RESOURCE,
  });
  const server = startHttpServer({
    host: env.HOST,
    port: env.PORT,
    version,
    features,
    ctx,
    logger,
    inventoryResource: env.INVENTORY_RESOURCE === 'on',
    loginPageState: () => credentials.loginPageState(),
  });

  const shutdown = (): void => {
    logger.info('shutting down');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(() => {
  process.stderr.write('Fatal: failed to start (details withheld).\n');
  process.exit(1);
});
