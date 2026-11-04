import { readFileSync } from 'node:fs';
import { buildFeatures } from './app/features.js';
import { startHttpServer } from './app/server.js';
import { Pseudonymizer } from './core/anonymizer/index.js';
import { loadContexts, loadEnv } from './core/config/index.js';
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

  const ctx = { pseudonymizer: new Pseudonymizer(aliases), logger };
  const features = buildFeatures({ version });

  logger.info('starting', {
    version,
    contexts: Object.keys(contexts.contexts).length,
    features: features.length,
  });
  const server = startHttpServer({ host: env.HOST, port: env.PORT, version, features, ctx, logger });

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
