import { PRIVATE_IP, PUBLIC_IP_CLIENT, PUBLIC_IP_PEER, VM_ARM_ID } from './values.js';

const remoteIp = (value: string): unknown => ({
  name: { value: 'RemoteIP', localizedValue: 'RemoteIP' },
  value,
});

/** A `Microsoft.Insights/metrics` response split by a dimension whose values are IPs. */
export const METRICS_RESPONSE: unknown = {
  cost: 59,
  timespan: '2026-11-03T08:00:00Z/2026-11-03T09:00:00Z',
  interval: 'PT1M',
  namespace: 'Microsoft.Compute/virtualMachines',
  resourceregion: 'westeurope',
  value: [
    {
      id: `${VM_ARM_ID}/providers/Microsoft.Insights/metrics/Inbound Flows`,
      type: 'Microsoft.Insights/metrics',
      name: { value: 'Inbound Flows', localizedValue: 'Inbound Flows' },
      displayDescription: 'Inbound flows by remote IP',
      unit: 'Count',
      errorCode: 'Success',
      timeseries: [
        {
          metadatavalues: [remoteIp(PUBLIC_IP_CLIENT)],
          data: [
            { timeStamp: '2026-11-03T08:00:00Z', total: 120 },
            { timeStamp: '2026-11-03T08:01:00Z', total: 98 },
          ],
        },
        {
          metadatavalues: [remoteIp(PUBLIC_IP_PEER)],
          data: [{ timeStamp: '2026-11-03T08:00:00Z', total: 7 }],
        },
        { metadatavalues: [remoteIp(PRIVATE_IP)], data: [{ timeStamp: '2026-11-03T08:00:00Z', total: 3 }] },
      ],
    },
  ],
};
