// Self-test fixture for test/read-only (never compiled, linted or run). `@azure/arm-compute` is not
// installed: the analyzer must still flag it from the import alone.
import { ComputeManagementClient } from '@azure/arm-compute';
import type { TokenCredential } from '@azure/core-auth';

export async function startVm(credential: TokenCredential): Promise<void> {
  const client = new ComputeManagementClient(credential, '00000000-0000-0000-0000-000000000001'); // expect: sdk-construction
  await client.virtualMachines.beginStart('rg-app', 'vm-web-01'); // expect: write-call
  await client['virtualMachines']['deallocate']('rg-app', 'vm-web-01'); // expect: write-call
}
