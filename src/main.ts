import { readFileSync } from 'node:fs';
import { buildFeatures } from './app/features.js';
import { startHttpServer } from './app/server.js';
import { Pseudonymizer } from './core/anonymizer/index.js';
import {
  createAzureAccess,
  createClientFactory,
  createContextStore,
  createCredentialManager,
  createResourceGraph,
  createResourceResolver,
} from './core/azure/index.js';
import { loadContexts, loadEnv, loginPageUrl } from './core/config/index.js';
import { createLogger } from './core/logging/index.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const contexts = await loadContexts(env.CONTEXTS_FILE);

  // Known IDs are shown to the AI by alias only (tenant:<ctx>, <subscription alias>).
  const aliases = new Map<string, string>();
  for (const [ctxAlias, c] of Object.entries(contexts.contexts)) {
    aliases.set(c.tenantId, `tenant-${ctxAlias}`);
    for (const [subAlias, subId] of Object.entries(c.subscriptions)) aliases.set(subId, subAlias);
  }

  const credentials = createCredentialManager({ contexts: contexts.contexts, logger });
  const store = createContextStore({
    contexts: contexts.contexts,
    isLoggedIn: (alias) => credentials.isLoggedIn(alias),
    ...(contexts.defaultContext === undefined ? {} : { initialActive: contexts.defaultContext }),
  });
  const session = () => azure.session();
  const resourceGraph = createResourceGraph({ session, clients: createClientFactory() });
  const resolver = createResourceResolver({ resourceGraph, session, contexts: store });
  const azure = createAzureAccess({ contexts: contexts.contexts, store, credentials, resolver });

  const ctx = { pseudonymizer: new Pseudonymizer(aliases), logger, azure };
  const features = buildFeatures({ version, logins: credentials, loginUrl: loginPageUrl(env) });

  logger.info('starting', {
    version,
    contexts: Object.keys(contexts.contexts).length,
    features: features.length,
  });
  const server = startHttpServer({
    host: env.HOST,
    port: env.PORT,
    version,
    features,
    ctx,
    logger,
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
