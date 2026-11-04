import { FAKE_ACCESS_TOKEN } from '../../helpers/azure.js';
import { CLIENT_REQUEST_ID, CORRELATION_ID, REQUEST_ID, SUBSCRIPTION_ID, VM_ARM_ID } from './values.js';

const REQUEST_URL = `https://management.azure.com${VM_ARM_ID}?api-version=2024-07-01`;

/**
 * Shaped like `@azure/core-rest-pipeline`'s RestError: the message echoes the request URL
 * (with the subscription ID) and the request/response carry auth and correlation headers.
 */
export function createRestError(): Error {
  const err = new Error(
    `The Resource 'Microsoft.Compute/virtualMachines/vm-web-01' under resource group 'rg-app' was not found. ` +
      `Request: GET ${REQUEST_URL} (subscription ${SUBSCRIPTION_ID}, correlation ${CORRELATION_ID})`,
  );
  err.name = 'RestError';
  return Object.assign(err, {
    code: 'ResourceNotFound',
    statusCode: 404,
    request: {
      url: REQUEST_URL,
      method: 'GET',
      headers: {
        authorization: `Bearer ${FAKE_ACCESS_TOKEN}`,
        'x-ms-client-request-id': CLIENT_REQUEST_ID,
      },
    },
    response: {
      status: 404,
      headers: {
        'x-ms-correlation-request-id': CORRELATION_ID,
        'x-ms-request-id': REQUEST_ID,
      },
      bodyAsText: JSON.stringify({
        error: { code: 'ResourceNotFound', message: `Resource ${VM_ARM_ID} not found` },
      }),
    },
  });
}
