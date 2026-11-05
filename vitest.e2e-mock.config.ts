import { defineConfig } from 'vitest/config';

/** `npm run test:e2e-mock`: runs against the containers of docker-compose.mock.yml, not in `npm test`. */
export default defineConfig({
  test: {
    include: ['test/e2e-mock/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
