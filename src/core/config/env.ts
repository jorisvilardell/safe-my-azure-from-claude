import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8765),
  // 0.0.0.0 inside the container; docker-compose publishes it on 127.0.0.1 only.
  HOST: z.string().min(1).default('127.0.0.1'),
  CONTEXTS_FILE: z.string().min(1).default('config/contexts.yaml'),
  /** Base URL the user opens in a browser (login page). Defaults to http://127.0.0.1:<PORT>. */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** In-memory inventory index cap, per context. Over it, tools query live. 0 disables the index. */
  INVENTORY_MAX_RESOURCES: z.coerce.number().int().min(0).max(1_000_000).default(50_000),
  /**
   * `on` exposes the MCP resource `azure://inventory/<context>`. Off by default: it sends EVERY
   * resource name to the AI, where searching on demand reveals only the relevant ones.
   */
  INVENTORY_RESOURCE: z.enum(['on', 'off']).default('off'),
});

export type Env = z.infer<typeof EnvSchema>;

/** The /login page URL, built from config only (never from request headers). */
export function loginPageUrl(env: Pick<Env, 'PORT' | 'PUBLIC_URL'>): string {
  const base = env.PUBLIC_URL ?? `http://127.0.0.1:${env.PORT}`;
  return `${base.replace(/\/+$/, '')}/login`;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
