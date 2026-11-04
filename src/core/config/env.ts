import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8765),
  // 0.0.0.0 inside the container; docker-compose publishes it on 127.0.0.1 only.
  HOST: z.string().min(1).default('127.0.0.1'),
  CONTEXTS_FILE: z.string().min(1).default('config/contexts.yaml'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
