import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeReadOnly, type Finding } from './analyzer.js';

/**
 * AGENTS.md R2, statically: no Azure write call, no SDK client built outside the guarded client
 * factory, no raw HTTP in `src/`. How the analyzer decides is documented in `./analyzer.ts`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');
const FIXTURES = path.join(ROOT, 'test/read-only/fixtures');
const FACTORY = path.join(SRC, 'core/azure/client-factory.ts');
const TIMEOUT_MS = 120_000;

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(ROOT, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (parsed === undefined) throw new Error('tsconfig.json could not be read');
  return parsed.options;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f));
}

/** Production sources: every `src/**\/*.ts` except tests. */
const sourceFiles = (): string[] =>
  tsFiles(SRC).filter((f) => !/[\\/]__tests__[\\/]/.test(f) && !f.endsWith('.test.ts'));

const describeFinding = (f: Finding): string =>
  `${path.relative(ROOT, f.file).replace(/\\/g, '/')}:${f.line} ${f.rule}: ${f.text}`;

/** `// expect: <rule>` at the end of a fixture line means exactly that finding on that line. */
function expectedFindings(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => {
        const rule = /\/\/ expect: ([a-z-]+)\s*$/.exec(line)?.[1];
        return rule === undefined ? [] : [`${path.basename(file)}:${i + 1} ${rule}`];
      }),
  );
}

describe('read-only: static checks', () => {
  let options: ts.CompilerOptions;
  beforeAll(() => {
    options = compilerOptions();
  });

  it(
    'src/ has no Azure write call, no unguarded SDK client and no raw HTTP',
    () => {
      const files = sourceFiles();
      // Sanity: the scan really covers the services that call Azure.
      expect(files.some((f) => f.endsWith('logs.service.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('client-factory.ts'))).toBe(true);
      const findings = analyzeReadOnly(files, { factoryFile: FACTORY, compilerOptions: options });
      expect(findings.map(describeFinding)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'self-test: flags every bad fixture line and nothing else',
    () => {
      const files = tsFiles(FIXTURES);
      expect(files.length).toBeGreaterThanOrEqual(5);
      const findings = analyzeReadOnly(files, { factoryFile: FACTORY, compilerOptions: options });
      const got = findings.map((f) => `${path.basename(f.file)}:${f.line} ${f.rule}`).sort();
      const want = expectedFindings(files).sort();
      expect(want.length).toBeGreaterThanOrEqual(12);
      expect(got, findings.map(describeFinding).join('\n')).toEqual(want);
    },
    TIMEOUT_MS,
  );

  it(
    'self-test: the factory itself may build SDK clients',
    () => {
      const findings = analyzeReadOnly([FACTORY], { factoryFile: FACTORY, compilerOptions: options });
      expect(findings.map(describeFinding)).toEqual([]);
      const elsewhere = analyzeReadOnly([FACTORY], {
        factoryFile: path.join(SRC, 'main.ts'),
        compilerOptions: options,
      });
      expect(new Set(elsewhere.map((f) => f.rule))).toEqual(new Set(['sdk-construction']));
    },
    TIMEOUT_MS,
  );
});
