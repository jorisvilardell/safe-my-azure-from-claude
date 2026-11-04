import {
  CALLER_EMAIL,
  CLIENT_SECRET,
  CORRELATION_ID,
  PRIVATE_IP,
  PUBLIC_IP_CLIENT,
  PUBLIC_IP_PEER,
  SAS_URL,
  STORAGE_CONNECTION_STRING,
  VM_ARM_ID,
  WORKSPACE_ID,
} from './values.js';

/** A Log Analytics query response (`/v1/workspaces/{id}/query`). */
export const LOG_ANALYTICS_TABLE: unknown = {
  tables: [
    {
      name: 'PrimaryResult',
      columns: [
        { name: 'TimeGenerated', type: 'datetime' },
        { name: '_ResourceId', type: 'string' },
        { name: 'TenantId', type: 'string' },
        { name: 'CorrelationId', type: 'string' },
        { name: 'UserPrincipalName', type: 'string' },
        { name: 'CallerIpAddress', type: 'string' },
        { name: 'Message', type: 'string' },
      ],
      rows: [
        [
          '2026-11-03T08:04:11.000Z',
          VM_ARM_ID.toUpperCase(),
          WORKSPACE_ID,
          CORRELATION_ID,
          CALLER_EMAIL,
          PUBLIC_IP_CLIENT,
          `Downloading diagnostics from ${SAS_URL}`,
        ],
        [
          '2026-11-03T08:04:12.000Z',
          VM_ARM_ID,
          WORKSPACE_ID,
          CORRELATION_ID,
          CALLER_EMAIL,
          PUBLIC_IP_PEER,
          `app config: ${STORAGE_CONNECTION_STRING}`,
        ],
        [
          '2026-11-03T08:04:13.000Z',
          VM_ARM_ID,
          WORKSPACE_ID,
          CORRELATION_ID,
          CALLER_EMAIL,
          PRIVATE_IP,
          `token request failed: grant_type=client_credentials&client_secret=${CLIENT_SECRET}&scope=default`,
        ],
      ],
    },
  ],
};
