// Self-test fixture for test/read-only (never compiled, linted or run): a feature-style narrow
// interface over a client obtained from getClient().
import { azureClients, type AzureAccess } from '../../../src/core/azure/index.js';

interface VmClient {
  readonly virtualMachines: {
    get(rg: string, name: string): Promise<unknown>;
    powerOff(rg: string, name: string): Promise<void>;
    beginRestart(rg: string, name: string): Promise<void>;
  };
}

function vmClient(azure: AzureAccess): VmClient {
  return azure.clients.getClient<VmClient>(azure.session(), 'vm', azureClients.monitor() as never);
}

interface HealthOps {
  readonly events: { listBySubscriptionId(): AsyncIterable<unknown> };
}

/** Narrowed by the declared return type, with no type argument on getClient. */
function healthClient(azure: AzureAccess): HealthOps {
  return azure.clients.getClient(azure.session(), 'rh', azureClients.resourceHealth('sub'));
}

export async function purge(azure: AzureAccess): Promise<void> {
  for await (const e of healthClient(azure).events.listBySubscriptionId()) void e;
  await healthClient(azure).events.purgeAll(); // expect: write-call
}

export async function bounce(azure: AzureAccess): Promise<void> {
  const client = vmClient(azure);
  await client.virtualMachines.get('rg-app', 'vm-web-01');
  await client.virtualMachines.powerOff('rg-app', 'vm-web-01'); // expect: non-read-call
  await client.virtualMachines.beginRestart('rg-app', 'vm-web-01'); // expect: write-call
}
