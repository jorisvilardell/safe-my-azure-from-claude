// Self-test fixture for test/read-only (never compiled, linted or run): Azure without an SDK client.
import https from 'node:https';
import { request } from 'node:https';
import { fetch as undiciFetch } from 'undici'; // expect: raw-http

export async function tagResourceGroup(): Promise<void> {
  await fetch('https://management.azure.com/subscriptions/x/resourceGroups/y', { method: 'PUT' }); // expect: raw-http
  await globalThis.fetch('https://management.azure.com/'); // expect: raw-http
  https.request('https://management.azure.com/', { method: 'DELETE' }); // expect: raw-http
  request('https://api.loganalytics.io/v1/workspaces/x/purge', { method: 'POST' }); // expect: raw-http
  await undiciFetch('https://management.azure.com/');
}
