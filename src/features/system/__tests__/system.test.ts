import { describe, expect, it } from 'vitest';
import { createTestToolContext, parseToolText } from '../../../../test/helpers/index.js';
import { executeTool } from '../../../core/mcp/index.js';
import { createSystemFeature } from '../index.js';

describe('system feature', () => {
  const feature = createSystemFeature({
    version: '1.2.3',
    listFeatures: () => [{ name: 'system', description: 'Server metadata' }],
  });

  it('exposes server_info', () => {
    expect(feature.tools.map((t) => t.name)).toEqual(['server_info']);
  });

  it('returns version, guarantees and features', async () => {
    const tool = feature.tools[0];
    if (tool === undefined) throw new Error('missing tool');

    const result = await executeTool(tool, {}, createTestToolContext());

    expect(result.isError).toBeUndefined();
    const body = parseToolText(result) as { version: string; guarantees: string[]; features: unknown[] };
    expect(body.version).toBe('1.2.3');
    expect(body.guarantees.length).toBeGreaterThan(0);
    expect(body.features).toEqual([{ name: 'system', description: 'Server metadata' }]);
  });
});
