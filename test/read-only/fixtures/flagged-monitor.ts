// Self-test fixture for test/read-only (never compiled, linted or run): a typed SDK client.
import { MonitorClient } from '@azure/arm-monitor';
import type { TokenCredential } from '@azure/core-auth';

export async function deleteActionGroup(client: MonitorClient): Promise<void> {
  await client.actionGroups.delete('rg-app', 'ag-oncall'); // expect: write-call
}

export function takeWriter(client: MonitorClient): unknown {
  const { createOrUpdate } = client.actionGroups; // expect: write-call
  return createOrUpdate;
}

export function build(credential: TokenCredential): MonitorClient {
  return new MonitorClient(credential); // expect: sdk-construction
}

export class SneakyMonitor extends MonitorClient {} // expect: sdk-construction

export function unguard(client: MonitorClient): void {
  client.pipeline.removePolicy({ name: 'safeAzureReadOnly' }); // expect: write-call
}
