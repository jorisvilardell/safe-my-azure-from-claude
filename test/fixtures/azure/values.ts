/**
 * The sensitive literals planted in the fake Azure fixtures. Every one of them is fake
 * (AGENTS.md R7) and is a leak canary: none may ever reach the AI verbatim.
 */
export const SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000001';
export const TENANT_ID = '00000000-0000-0000-0000-0000000000aa';
export const CALLER_OBJECT_ID = '00000000-0000-0000-0000-0000000000c1';
export const APP_ID = '00000000-0000-0000-0000-0000000000c2';
export const CORRELATION_ID = '00000000-0000-0000-0000-0000000000d1';
export const REQUEST_ID = '00000000-0000-0000-0000-0000000000d2';
export const CLIENT_REQUEST_ID = '11111111-2222-3333-4444-555555555555';
export const ALERT_ID = '00000000-0000-0000-0000-0000000000e1';
export const EVENT_DATA_ID = '00000000-0000-0000-0000-0000000000e2';
export const VM_ID = '00000000-0000-0000-0000-0000000000e3';
export const WORKSPACE_ID = '00000000-0000-0000-0000-0000000000f1';

export const CALLER_EMAIL = 'alice.ops@contoso.example';
export const OWNER_EMAIL = 'bob.owner@fabrikam.example';

/** Documentation ranges (RFC 5737): public, so they must be anonymised. */
export const PUBLIC_IP_CLIENT = '203.0.113.42';
export const PUBLIC_IP_PEER = '198.51.100.7';
/** Private IPs are allowed through (AGENTS.md G2); kept in fixtures to prove it. */
export const PRIVATE_IP = '10.0.1.4';

/** JWT-shaped, header `{"alg":"none"}`. */
export const FAKE_ID_TOKEN = 'eyJhbGciOiJub25lIn0.eyJvaWQiOiJmYWtlLW9pZCJ9.ZmFrZS1pZC10b2tlbg';
export const SAS_SIGNATURE = 'FAKEsasSig0123456789abcdefFAKE';
export const STORAGE_ACCOUNT_KEY = 'RkFLRS1zdG9yYWdlLWtleS1ub3QtcmVhbA==';
export const CLIENT_SECRET = 'Fake~ClientSecret.0123456789';

export const VM_ARM_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-web-01`;
export const ALERT_RULE_ARM_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-app/providers/Microsoft.Insights/metricAlerts/cpu-high`;
export const SAS_URL = `https://stfakelogs.blob.core.windows.net/insights-logs/vm.json?sv=2022-11-02&ss=b&srt=o&sp=r&se=2026-12-31T00:00:00Z&sig=${SAS_SIGNATURE}%3D`;
export const STORAGE_CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=stfakelogs;AccountKey=${STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`;
