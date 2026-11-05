// Self-test fixture for test/read-only (never compiled, linted or run): nothing here may be flagged.
import type { MonitorClient } from '@azure/arm-monitor';
import type { AvailabilityStatus } from '@azure/arm-resourcehealth';
import { DeviceCodeCredential } from '@azure/identity';
import { azureClients, type AzureAccess } from '../../../src/core/azure/index.js';

interface MetricsClient {
  readonly metrics: { list(uri: string): Promise<unknown> };
}

export async function reads(azure: AzureAccess, client: MonitorClient, uri: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const d of client.metricDefinitions.list(uri)) out.push(d);
  for await (const page of client.metricDefinitions.list(uri).byPage()) out.push(page);
  const narrow = azure.clients.getClient<MetricsClient>(azure.session(), 'm', azureClients.monitor());
  out.push(await narrow.metrics.list(uri));
  out.push(await azure.resourceGraph.query('resources | take 1'));
  return out;
}

export function lookalikes(status: AvailabilityStatus): string {
  const seen = new Map<string, number>();
  seen.set('a', 1);
  seen.delete('a');
  const ids = new Set(['x']);
  ids.delete('x');
  const params = new URLSearchParams();
  params.set('api-version', '2024-01-01');
  const d = new Date();
  d.setUTCHours(0);
  const started = status.properties?.occurredTime;
  const rows = [{ name: 'vm' }].find((r) => r.name.startsWith('v'));
  const credential = new DeviceCodeCredential({ tenantId: '00000000-0000-0000-0000-0000000000aa' });
  return `${String(started)} ${rows?.name ?? ''} ${typeof credential}`;
}
