import path from 'node:path';
import ts from 'typescript';

/**
 * Static half of AGENTS.md R2 (read-only), run by `test/read-only/read-only.test.ts`.
 *
 * It type-checks the given files with the TypeScript compiler API and reports:
 *
 * - `write-call`: a member whose name looks like a write (`WRITE_VERB`) used as a function on an
 *   **Azure receiver** (below). Data reads such as `properties.startTime` are not calls, so they pass.
 * - `non-read-call`: a call on an Azure receiver whose method is not in `READ_METHODS`, which
 *   catches writes the verb list misses (`powerOff`). A POST behind a read-looking name (`listKeys`)
 *   passes here; the runtime guard refuses it, since it is not in `READ_ONLY_POSTS`.
 * - `sdk-construction`: `new X(...)` of an Azure SDK client (a class from an `@azure/*` client
 *   package, named `*Client` / `MicrosoftResourceHealth`, or with a `pipeline`) outside the client
 *   factory, or a class extending one. Only the factory installs the runtime guard.
 * - `raw-http`: `fetch()`, `http(s).request/get`, or an import of `undici`, `node-fetch`, `axios`,
 *   `got`. `src/` reaches Azure through SDK clients only, so the guard sees every request.
 *
 * An **Azure receiver** is an expression whose type is:
 * 1. declared in an Azure SDK client package (`@azure/arm-*`, `@azure/monitor-*`, `@azure-rest/*`,
 *    `@azure/core-rest-pipeline`, `@azure/core-client`, `@typespec/ts-http-runtime`), e.g.
 *    `client.virtualMachines` in `client.virtualMachines.beginStart()`; or
 * 2. returned by a `getClient(...)` call (or the type it is narrowed to: type argument, `as`, the
 *    declared return or variable type), or a property of such a type, recursively. This covers the
 *    narrow interfaces features declare so tests can stub clients (`MonitorMetricsClient`, …); or
 * 3. unresolved (`any` / error type) and syntactically rooted in an `@azure/*` import, e.g. a
 *    variable initialised with `new ComputeManagementClient(...)` when the package is not installed.
 *
 * Types from TypeScript's lib, `@types/node` and other packages never count, so `Map.set`,
 * `Array.find`, `Set.delete`, `URLSearchParams.set` or `res.set()` are not flagged.
 */

export type FindingRule = 'write-call' | 'non-read-call' | 'sdk-construction' | 'raw-http';

export interface Finding {
  readonly rule: FindingRule;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export const WRITE_VERB =
  /^(begin|create|update|delete|remove|put|patch|post(?!Query)|set|start|stop|restart|deallocate|redeploy|reimage|regenerate|rotate|purge|move|validateMove|enable|disable|generate|import|export|upgrade|failover|cancel|refresh|sync|trigger|run)/i;

/**
 * The read-only methods the code calls on Azure receivers: `list*` / `get*` (ARM GETs, e.g.
 * `metrics.list`, `metricDefinitions.list`, `activityLogs.list`, `availabilityStatuses.getByResource`
 * / `.list`, `events.listBySubscriptionId`), `query*` (`queryWorkspace`, `queryResource`),
 * `resources` (Resource Graph query), and paging helpers.
 */
export const READ_METHODS = /^(list\w*|get\w*|query\w*|resources|byPage|next|return)$/;

const SDK_DECLARATION =
  /[\\/]node_modules[\\/](?:@azure-rest[\\/]|@azure[\\/](?:arm-|monitor-|core-rest-pipeline[\\/]|core-client[\\/])|@typespec[\\/]ts-http-runtime[\\/])/;
const AZURE_MODULE = /^@azure(?:-rest)?\//;
const RAW_HTTP_MODULES = /^(?:undici|node-fetch|axios|got)(?:\/|$)/;
const NODE_HTTP_MODULES = /^(?:node:)?https?$/;
const SDK_CLIENT_NAME = /(?:Client|^MicrosoftResourceHealth)$/;

export interface AnalyzeOptions {
  /** Absolute path of `src/core/azure/client-factory.ts`: the only file allowed to `new` a client. */
  readonly factoryFile: string;
  readonly compilerOptions: ts.CompilerOptions;
}

const norm = (file: string): string => path.resolve(file).replace(/\\/g, '/').toLowerCase();

export function analyzeReadOnly(files: readonly string[], opts: AnalyzeOptions): Finding[] {
  const program = ts.createProgram({
    rootNames: [...files],
    options: { ...opts.compilerOptions, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map(norm));
  const sources = program.getSourceFiles().filter((s) => wanted.has(norm(s.fileName)));
  const factory = norm(opts.factoryFile);
  const findings: Finding[] = [];

  const report = (rule: FindingRule, node: ts.Node): void => {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ rule, file: sf.fileName, line: line + 1, text: node.getText(sf).slice(0, 120) });
  };

  // --- Azure-ish types -------------------------------------------------------------------------

  const declaredInSdk = (type: ts.Type): boolean => {
    const symbols = [type.getSymbol(), type.aliasSymbol].filter((s) => s !== undefined);
    return symbols.some((s) =>
      (s.declarations ?? []).some((d) => SDK_DECLARATION.test(d.getSourceFile().fileName)),
    );
  };

  const members = (type: ts.Type): ts.Type[] =>
    type.isUnion() ? type.types.flatMap(members) : [checker.getNonNullableType(type)];

  /** Types returned by `getClient(...)`, plus their property types, recursively. */
  const clientTypes = new Set<ts.Type>();
  const addClientType = (type: ts.Type, depth: number): void => {
    for (const t of members(type)) {
      if (clientTypes.has(t) || depth > 4) continue;
      clientTypes.add(t);
      if (t.flags & ts.TypeFlags.Object) {
        for (const prop of checker.getPropertiesOfType(t)) {
          const decl = prop.valueDeclaration ?? prop.declarations?.[0];
          if (decl === undefined) continue;
          const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
          if (propType.getCallSignatures().length === 0) addClientType(propType, depth + 1);
        }
      }
    }
  };

  const calleeName = (expr: ts.LeftHandSideExpression): string | undefined => {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
      return expr.argumentExpression.text;
    }
    return undefined;
  };

  for (const sf of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node.expression) === 'getClient') {
        // The client may be narrowed on the way out: `return getClient(...)` in a function typed
        // `(): ResourceHealthClient`, `getClient(...) as X`, `const c: X = getClient(...)`.
        let outer: ts.Expression = node;
        addClientType(checker.getTypeAtLocation(outer), 0);
        while (
          ts.isParenthesizedExpression(outer.parent) ||
          ts.isAsExpression(outer.parent) ||
          ts.isSatisfiesExpression(outer.parent) ||
          ts.isNonNullExpression(outer.parent) ||
          ts.isTypeAssertionExpression(outer.parent) ||
          ts.isAwaitExpression(outer.parent)
        ) {
          outer = outer.parent;
          addClientType(checker.getTypeAtLocation(outer), 0);
        }
        const contextual = checker.getContextualType(outer);
        if (contextual !== undefined) addClientType(contextual, 0);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // --- Syntactic origin, for unresolved types --------------------------------------------------

  const importModuleOf = (decl: ts.Declaration): string | undefined => {
    let n: ts.Node = decl;
    while (!ts.isSourceFile(n) && !ts.isImportDeclaration(n)) n = n.parent;
    return ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)
      ? n.moduleSpecifier.text
      : undefined;
  };

  const isImportDecl = (d: ts.Declaration): boolean =>
    ts.isImportSpecifier(d) ||
    ts.isImportClause(d) ||
    ts.isNamespaceImport(d) ||
    ts.isImportEqualsDeclaration(d);

  /** True when `id` names something imported from an `@azure/*` module. */
  const fromAzureImport = (id: ts.Identifier): boolean => {
    const symbol = checker.getSymbolAtLocation(id);
    return (symbol?.declarations ?? []).some((d) => {
      if (isImportDecl(d)) return AZURE_MODULE.test(importModuleOf(d) ?? '');
      return SDK_DECLARATION.test(d.getSourceFile().fileName);
    });
  };

  const typeRefFromAzure = (typeNode: ts.TypeNode | undefined): boolean => {
    if (typeNode === undefined) return false;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (ts.isTypeReferenceNode(n)) {
        const name = ts.isIdentifier(n.typeName) ? n.typeName : n.typeName.left;
        if (ts.isIdentifier(name) && fromAzureImport(name)) found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(typeNode);
    return found;
  };

  const rootIdentifier = (expr: ts.Expression): ts.Identifier | undefined => {
    let e: ts.Expression = expr;
    for (;;) {
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
      else if (ts.isCallExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e))
        e = e.expression;
      else if (ts.isAwaitExpression(e)) e = e.expression;
      else break;
    }
    return ts.isIdentifier(e) ? e : undefined;
  };

  const azureOrigin = (expr: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const root = rootIdentifier(expr);
    if (root === undefined) return false;
    if (fromAzureImport(root)) return true;
    for (const d of checker.getSymbolAtLocation(root)?.declarations ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (
        (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d)) &&
        typeRefFromAzure(d.type)
      ) {
        return true;
      }
      if (ts.isVariableDeclaration(d) && d.initializer !== undefined) {
        const init = d.initializer;
        if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && fromAzureImport(init.expression))
          return true;
        if (azureOrigin(init, seen)) return true;
      }
    }
    return false;
  };

  const isAzureReceiver = (expr: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(expr);
    const parts = members(type);
    if (parts.some((t) => declaredInSdk(t) || clientTypes.has(t))) return true;
    const unresolved = parts.some((t) => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0);
    return unresolved && azureOrigin(expr);
  };

  // --- SDK construction -------------------------------------------------------------------------

  const isSdkClientClass = (expr: ts.Expression): boolean => {
    const id = ts.isIdentifier(expr) ? expr : ts.isPropertyAccessExpression(expr) ? expr.name : undefined;
    if (id === undefined) return false;
    let symbol = checker.getSymbolAtLocation(id);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased.declarations !== undefined) symbol = aliased;
    }
    const decls = symbol?.declarations ?? [];
    const fromSdk =
      decls.some((d) => SDK_DECLARATION.test(d.getSourceFile().fileName)) ||
      (ts.isIdentifier(expr) && fromAzureImport(expr)) ||
      (ts.isPropertyAccessExpression(expr) && azureOrigin(expr.expression));
    if (!fromSdk) return false;
    if (SDK_CLIENT_NAME.test(id.text)) return true;
    const instance = checker.getTypeAtLocation(expr).getConstructSignatures()[0]?.getReturnType();
    return instance?.getProperty('pipeline') !== undefined;
  };

  // --- Walk -------------------------------------------------------------------------------------

  for (const sf of sources) {
    const inFactory = norm(sf.fileName) === factory;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        calleeName(node) !== undefined
      ) {
        const name = calleeName(node) ?? '';
        const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
        const callable = isCallee || checker.getTypeAtLocation(node).getCallSignatures().length > 0;
        if (callable && isAzureReceiver(node.expression)) {
          if (WRITE_VERB.test(name)) report('write-call', node);
          else if (isCallee && !inFactory && !READ_METHODS.test(name)) report('non-read-call', node);
        }
      }

      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        // `const { beginStart } = client.virtualMachines`
        const decl = node.parent.parent;
        const key = node.propertyName ?? node.name;
        if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined && ts.isIdentifier(key)) {
          if (WRITE_VERB.test(key.text) && isAzureReceiver(decl.initializer)) report('write-call', node);
        }
      }

      if (ts.isNewExpression(node) && !inFactory && isSdkClientClass(node.expression)) {
        report('sdk-construction', node);
      }
      if (ts.isClassLike(node) && !inFactory) {
        for (const clause of node.heritageClauses ?? []) {
          for (const t of clause.types) if (isSdkClientClass(t.expression)) report('sdk-construction', t);
        }
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === 'fetch') report('raw-http', node);
        if (ts.isPropertyAccessExpression(callee)) {
          const name = callee.name.text;
          if (
            name === 'fetch' &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'globalThis'
          ) {
            report('raw-http', node);
          }
          if ((name === 'request' || name === 'get') && ts.isIdentifier(callee.expression)) {
            const module = (checker.getSymbolAtLocation(callee.expression)?.declarations ?? [])
              .filter(isImportDecl)
              .map((d) => importModuleOf(d) ?? '');
            if (module.some((m) => NODE_HTTP_MODULES.test(m))) report('raw-http', node);
          }
        }
        if (ts.isIdentifier(callee) && (callee.text === 'request' || callee.text === 'get')) {
          const module = (checker.getSymbolAtLocation(callee)?.declarations ?? [])
            .filter(isImportDecl)
            .map((d) => importModuleOf(d) ?? '');
          if (module.some((m) => NODE_HTTP_MODULES.test(m))) report('raw-http', node);
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (RAW_HTTP_MODULES.test(node.moduleSpecifier.text)) report('raw-http', node);
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return findings;
}
