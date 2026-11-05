import { describe, expect, it } from 'vitest';
import { ResourceGroupName, ResourceName, ResourceType, SubscriptionAlias } from '../index.js';

// FAKE identifiers only (AGENTS.md R7).
const SUB = '00000000-0000-0000-0000-000000000001';
const VM_ID = `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-web-01`;

describe('shared name-based input schemas (#53)', () => {
  it.each([
    [
      'subscription',
      SubscriptionAlias,
      ['prod-app', 'lab'],
      [`/subscriptions/${SUB}`, 'Prod-App', 'prod app', ''],
    ],
    [
      'resourceGroup',
      ResourceGroupName,
      ['rg-app', 'RG_App.(blue)', 'rg-é'],
      ['rg app', "rg'", 'a'.repeat(91), ''],
    ],
    [
      'name',
      ResourceName,
      ['vm-web-01', 'vm_web.(01)'],
      [VM_ID, 'rg/vm', "x' or 1==1", 'a\nb', 'a'.repeat(261), ''],
    ],
    [
      'type',
      ResourceType,
      ['Microsoft.Compute/virtualMachines', 'virtualMachines', 'Microsoft.Sql/servers/databases'],
      ['Microsoft.Compute/virtualMachines | take 1', '/virtualMachines', ''],
    ],
  ] as const)('%s', (_label, schema, good, bad) => {
    for (const value of good) expect(schema.safeParse(value).success, value).toBe(true);
    for (const value of bad) expect(schema.safeParse(value).success, value).toBe(false);
  });
});
