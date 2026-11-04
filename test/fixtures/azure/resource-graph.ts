import { CALLER_EMAIL, OWNER_EMAIL, SUBSCRIPTION_ID, TENANT_ID, VM_ARM_ID, VM_ID } from './values.js';

/** A Resource Graph query response with one VM row. */
export const RESOURCE_GRAPH_RESPONSE: unknown = {
  totalRecords: 1,
  count: 1,
  resultTruncated: 'false',
  facets: [],
  data: [
    {
      id: VM_ARM_ID,
      name: 'vm-web-01',
      type: 'microsoft.compute/virtualmachines',
      location: 'westeurope',
      resourceGroup: 'rg-app',
      subscriptionId: SUBSCRIPTION_ID,
      tenantId: TENANT_ID,
      tags: { owner: OWNER_EMAIL, 'created-by': CALLER_EMAIL, env: 'prod' },
      properties: {
        vmId: VM_ID,
        hardwareProfile: { vmSize: 'Standard_D2s_v5' },
        provisioningState: 'Succeeded',
        networkProfile: {
          networkInterfaces: [
            {
              id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-app/providers/Microsoft.Network/networkInterfaces/vm-web-01-nic`,
            },
          ],
        },
      },
    },
  ],
};
