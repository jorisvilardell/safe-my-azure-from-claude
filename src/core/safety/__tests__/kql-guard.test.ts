import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors/index.js';
import { guardKql, KQL_MAX_QUERY_LENGTH } from '../index.js';

function rejection(query: string, opts?: Parameters<typeof guardKql>[1]): AppError {
  try {
    guardKql(query, opts);
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected the query to be rejected');
}

describe('guardKql: accepted queries', () => {
  it.each([
    ['simple table', 'AppRequests'],
    ['pipeline', 'AppRequests | where Success == false | summarize count() by bin(TimeGenerated, 5m)'],
    ['let statements', 'let threshold = 500;\nlet T = AppRequests | where DurationMs > threshold;\nT'],
    ['trailing semicolon', 'AppRequests | count;'],
    ['lambda with nested semicolons', 'let f = (n: int) { let m = n * 2; AppRequests | take m };\nf(3)'],
    ['safe plugin', 'AppRequests | evaluate bag_unpack(Properties)'],
    ['safe plugin with hint', 'T | evaluate hint.distribution = per_node autocluster()'],
    ['dotted column access', 'T | extend v = Properties.name'],
    ['column named cluster', 'T | where cluster == "x" | project cluster'],
    ['bracket identifier', "T | project ['my-col']"],
    ['dynamic array of strings', "print dynamic(['externaldata', 'cluster'])"],
    [
      'forbidden words in a string',
      'T | where Message has "externaldata cluster(\'x\') .show tables; set notruncation"',
    ],
    ['forbidden words in a verbatim string', "T | where Path == @'C:\\cluster(x)\\.show'"],
    ['forbidden words in an obfuscated string', 'T | where Token == h\'evaluate http_request("x")\''],
    ['forbidden words in a multi-line string', 'print s = ```\n.show tables\nexternaldata\n```'],
    ['escaped quote in string', 'T | where Message == "say \\"evaluate python()\\" now"'],
    ['doubled quote in verbatim', "T | where Message == @'it''s .show'"],
    ['comment with forbidden words', 'T // .show tables; externaldata; cluster("x")\n| take 5'],
    ['url in a string is not a comment', 'T | where Url == "https://example.test/a" | take 5'],
  ])('%s', (_, query) => {
    expect(() => guardKql(query)).not.toThrow();
  });
});

describe('guardKql: rejected queries', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '  \n\t '],
    ['comment only', '// nothing here'],
    ['control command', '.show tables'],
    ['control command after spaces', '   \n  .show databases'],
    ['control command after a statement', 'T | take 1; .show tables'],
    ['control command after let', 'let x = 1;\n.drop table T'],
    ['control command on its own line without semicolon', 'T | take 1\n.set-or-append T2 <| T'],
    ['control command hidden after a comment', '// harmless\n.show tables'],
    ['control command after a comment-ended line', 'T | take 1 // ;\n;.purge table T'],
    ['client directive', '#connect cluster("x")'],
    ['externaldata', "externaldata (a: string) ['https://example.test/x.csv']"],
    ['externaldata mixed case', "EXTERNALDATA (a: string) ['https://example.test/x.csv']"],
    [
      'externaldata with newlines',
      "T | join (\n  ExternalData\n  (a: string)\n  [@'https://example.test/x']) on a",
    ],
    ['external_table', 'external_table("x") | take 1'],
    ['evaluate http_request', "evaluate http_request('https://example.test')"],
    [
      'evaluate http_request_post',
      "T | evaluate http_request_post('https://example.test', dynamic({}), 'x')",
    ],
    ['evaluate mixed case', "T | EVALUATE Http_Request('https://example.test')"],
    ['evaluate python', "T | evaluate python(typeof(*), 'result = df')"],
    ['evaluate sql_request', "evaluate sql_request('Server=x', 'select 1')"],
    ['evaluate unknown hint', "T | evaluate hint.remote = auto http_request('x')"],
    ['evaluate without plugin', 'T | evaluate'],
    ['cluster()', 'cluster("other").database("db").T'],
    ['cluster ( with spaces', 'cluster  (\n"other").database("db").T'],
    ['database()', 'database("other").T'],
    ['workspace()', 'union workspace("other").AppRequests, AppRequests'],
    ['app()', 'app("other").requests'],
    ['resource()', 'resource("x").AzureActivity'],
    ['adx()', 'adx("https://example.test/db").T'],
    ['arg()', 'arg("").Resources'],
    ['bracket-quoted cluster', "['cluster']('other').database('db').T"],
    ['cross-scope inside let', 'let T = Workspace("other").AppRequests;\nT'],
    ['set notruncation', 'set notruncation;\nT'],
    ['set truncationmaxrecords', 'SET truncationmaxrecords = 1000000; T'],
    ['set after let', 'let x = 1; set notruncation; T'],
    ['alias statement', 'alias database db = cluster("x").database("y"); T'],
    ['declare statement', 'declare query_parameters(n: long = 1); T'],
    ['two result sets', 'T | take 1; T2 | take 1'],
    ['ends with let', 'let x = T;'],
    ['fork', 'T | fork (take 1) (take 2)'],
    ['facet', 'T | facet by a'],
    ['unbalanced brackets', 'T | where (a == 1'],
    ['stray closing bracket', 'T | where a == 1); .show tables'],
    ['empty pipe stage', 'T | | take 5'],
    ['unterminated string', "T | where a == 'x"],
    ['unterminated multi-line string', 'print ```\n.show'],
  ])('%s', (_, query) => {
    const err = rejection(query);
    expect(err.code).toBe('KqlRejected');
  });

  it('rejects overly long queries', () => {
    const query = `T | where a == "${'x'.repeat(KQL_MAX_QUERY_LENGTH)}"`;
    expect(rejection(query).message).toContain('too long');
  });

  it('never echoes the query in the rejection message', () => {
    const secret = 'sk-test-0000000000000000';
    const err = rejection(`T | where k == "${secret}" | evaluate http_request("https://${secret}.test")`);
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain('example');
  });
});

describe('guardKql: row cap', () => {
  it.each([
    ['appends take when missing', 'T | where a > 1', {}, 'T | where a > 1\n| take 500'],
    ['keeps a smaller take', 'T | take 10', {}, 'T | take 10'],
    ['keeps limit equal to the cap', 'T | limit 500', {}, 'T | limit 500'],
    ['keeps a small top', 'T | top 20 by Duration desc', {}, 'T | top 20 by Duration desc'],
    ['wraps a larger take', 'T | take 100000', {}, 'T | take 100000\n| take 500'],
    ['wraps a larger top', 'T | top 9999 by a', {}, 'T | top 9999 by a\n| take 500'],
    ['wraps a non-literal take', 'let n = 10; T | take n', {}, 'let n = 10; T | take n\n| take 500'],
    ['honours maxRows', 'T | take 100', { maxRows: 50 }, 'T | take 100\n| take 50'],
    [
      'take in a subquery does not count',
      'T | join (U | take 1) on a',
      {},
      'T | join (U | take 1) on a\n| take 500',
    ],
    [
      'caps before render',
      'T | summarize count() by a | render barchart',
      {},
      'T | summarize count() by a\n| take 500 | render barchart',
    ],
    ['keeps take before render', 'T | take 5 | render table', {}, 'T | take 5 | render table'],
    ['drops trailing semicolons', 'T;;', {}, 'T\n| take 500'],
    ['comment at the end cannot swallow the cap', 'T // trailing', {}, 'T\n| take 500'],
    ['comments are stripped', 'T // c1\n| where a == 1 // c2\n| take 5', {}, 'T \n| where a == 1 \n| take 5'],
  ])('%s', (_, query, opts, expected) => {
    expect(guardKql(query, opts).query).toBe(expected);
  });

  it('rejects an invalid maxRows', () => {
    expect(() => guardKql('T', { maxRows: 0 })).toThrow(RangeError);
    expect(() => guardKql('T', { maxRows: 1.5 })).toThrow(RangeError);
  });
});

describe('guardKql: timespan', () => {
  it.each([
    ['default', undefined, {}, { duration: 'P1D' }],
    ['default with a short max', undefined, { maxTimespanDays: 0.5 }, { duration: 'PT43200S' }],
    ['hours', 'PT1H', {}, { duration: 'PT1H' }],
    ['lower case', 'pt30m', {}, { duration: 'PT30M' }],
    ['exactly the max', 'P7D', {}, { duration: 'P7D' }],
    ['one week', 'P1W', {}, { duration: 'P1W' }],
    ['mixed', 'P1DT12H', {}, { duration: 'P1DT12H' }],
    ['custom max', 'P30D', { maxTimespanDays: 30 }, { duration: 'P30D' }],
    [
      'start/end object',
      { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
      {},
      { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' },
    ],
    [
      'start/end with offset',
      { start: '2026-01-01T02:00:00+02:00', end: '2026-01-01T06:00:00+02:00' },
      {},
      { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T04:00:00.000Z' },
    ],
    [
      'interval string',
      '2026-01-01/2026-01-08',
      {},
      { start: '2026-01-01T00:00:00.000Z', end: '2026-01-08T00:00:00.000Z' },
    ],
    [
      'Date objects',
      { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-01T01:00:00Z') },
      {},
      { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' },
    ],
  ] as const)('%s', (_, timespan, opts, expected) => {
    const options = timespan === undefined ? opts : { ...opts, timespan };
    expect(guardKql('T', options).timespan).toEqual(expected);
  });

  it.each([
    ['too long duration', 'P8D'],
    ['too long in hours', 'PT169H'],
    ['two weeks', 'P2W'],
    ['years are ambiguous', 'P1Y'],
    ['months are ambiguous', 'P1M'],
    ['zero', 'PT0S'],
    ['not a duration', '7 days'],
    ['bare P', 'P'],
    ['dangling T', 'P1DT'],
    ['negative', '-P1D'],
    ['interval too long', '2026-01-01/2026-01-09'],
    ['interval reversed', '2026-01-02/2026-01-01'],
    ['interval with three parts', '2026-01-01/2026-01-02/2026-01-03'],
    ['local time without offset', '2026-01-01T00:00/2026-01-01T01:00'],
    ['garbage dates', 'yesterday/today'],
    ['invalid calendar date', '2026-13-01/2026-13-02'],
  ])('rejects %s', (_, timespan) => {
    expect(rejection('T', { timespan }).code).toBe('KqlRejected');
  });

  it('rejects an object range above the max', () => {
    const timespan = { start: '2026-01-01T00:00:00Z', end: '2026-01-31T00:00:00Z' };
    expect(rejection('T', { timespan }).message).toContain('7 days');
  });

  it('rejects an invalid Date', () => {
    const timespan = { start: new Date('nope'), end: new Date('2026-01-01T00:00:00Z') };
    expect(rejection('T', { timespan }).code).toBe('KqlRejected');
  });

  it('rejects an invalid maxTimespanDays', () => {
    expect(() => guardKql('T', { maxTimespanDays: -1 })).toThrow(RangeError);
  });
});
