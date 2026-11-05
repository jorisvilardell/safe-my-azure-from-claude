import { z } from 'zod';
import { DEFAULT_KEYS_FILE } from '../auth/index.js';

/** docker-compose passes unset variables as `""`: treat them as absent. */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8765),
    // 0.0.0.0 inside the container; docker-compose publishes it on 127.0.0.1 only.
    HOST: z.string().min(1).default('127.0.0.1'),
    CONTEXTS_FILE: z.string().min(1).default('config/contexts.yaml'),
    /**
     * Where the server writes its `mcp` and `admin` keys at startup (mode 0600). The container
     * mounts a tmpfs there; tests point it at a temp dir. ADR 0001 §1.
     */
    KEYS_FILE: z.string().min(1).default(DEFAULT_KEYS_FILE),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** In-memory inventory index cap, per context. Over it, tools query live. 0 disables the index. */
    INVENTORY_MAX_RESOURCES: z.coerce.number().int().min(0).max(1_000_000).default(50_000),
    /**
     * `on` exposes the MCP resource `azure://inventory/<context>`. Off by default: it sends EVERY
     * resource name to the AI, where searching on demand reveals only the relevant ones.
     */
    INVENTORY_RESOURCE: z.enum(['on', 'off']).default('off'),
    /** Audit trail of tool calls (scrubbed): stderr, an append-only JSONL file, or off. */
    AUDIT_LOG: z.enum(['stderr', 'file', 'off']).default('stderr'),
    /** Required with AUDIT_LOG=file, rejected otherwise. Never defaulted: writing to disk is opt-in. */
    AUDIT_LOG_FILE: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.AUDIT_LOG === 'file' && env.AUDIT_LOG_FILE === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUDIT_LOG_FILE'],
        message: 'AUDIT_LOG=file needs AUDIT_LOG_FILE.',
      });
    }
    if (env.AUDIT_LOG !== 'file' && env.AUDIT_LOG_FILE !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUDIT_LOG_FILE'],
        message: 'AUDIT_LOG_FILE is only allowed with AUDIT_LOG=file.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
