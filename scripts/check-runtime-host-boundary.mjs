#!/usr/bin/env node
/**
 * Guards `packages/runtime` against reaching into a host.
 *
 * Runtime is the cross-platform layer: Electron, the mobile app, and the
 * headless node all sit above it. Two kinds of edge break that, and both have
 * happened:
 *
 * 1. Importing the `electron` npm package. Eight call sites read `app.isPackaged`
 *    and `app.getAppPath()` directly; they now go through the injected
 *    `HostEnvironment` (`src/host/hostEnvironment.ts`).
 * 2. A relative path that escapes the package into `packages/electron`.
 *    `ClaudeCodeProvider` imported `HistoryManager` this way, which pulled ~51
 *    files of the desktop app -- settings store, credential vault, logger --
 *    into the graph of anything touching session execution. It is now the
 *    `HistoryManagerPort` on `ClaudeCodeDeps`.
 *
 * Type-only imports count. They do not survive emit, but they force the whole
 * host graph through the typechecker, so a Node build still has to satisfy them.
 *
 * `src/electron/` is scanned like everything else: the directory name is
 * historical, and nothing under it may import Electron either.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const runtimeSrc = path.join(repoRoot, 'packages/runtime/src');

export const RUNTIME_FORBIDDEN_HOST_IMPORTS = [
  {
    name: 'electron',
    test: (id) => id === 'electron' || id.startsWith('electron/'),
  },
  {
    name: 'packages/electron',
    // Relative specifiers are resolved to absolute paths before this runs, so a
    // `../../../../../electron/src/main/...` escape shows up here.
    test: (id) => id.includes(`${path.sep}packages${path.sep}electron${path.sep}`)
      || id === '@nimbalyst/electron'
      || id.startsWith('@nimbalyst/electron/'),
  },
];

export function findRuntimeHostViolations(entries) {
  return RUNTIME_FORBIDDEN_HOST_IMPORTS.flatMap(({ name, test }) => {
    const hits = entries.filter(({ specifier, resolved }) => test(resolved ?? specifier));
    return hits.length > 0 ? [{ name, hits }] : [];
  });
}

function sourceFilesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    // Tests are allowed to mock `electron`; only shipped source is guarded.
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) return [];
    return /\.[cm]?tsx?$/.test(entry.name) ? [entryPath] : [];
  }).filter((filePath) => !filePath.includes(`${path.sep}__tests__${path.sep}`));
}

function moduleSpecifiers(filePath) {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

export function collectRuntimeHostImports(root = runtimeSrc) {
  return sourceFilesUnder(root).flatMap((filePath) =>
    moduleSpecifiers(filePath).map((specifier) => ({
      file: path.relative(repoRoot, filePath),
      specifier,
      resolved: specifier.startsWith('.')
        ? path.resolve(path.dirname(filePath), specifier)
        : specifier,
    })));
}

export function checkRuntimeHostBoundary() {
  const entries = collectRuntimeHostImports();
  const violations = findRuntimeHostViolations(entries);
  if (violations.length > 0) {
    const details = violations.flatMap(({ name, hits }) => [
      `${name}:`,
      ...hits.map((hit) => `  + ${hit.file} imports ${hit.specifier}`),
    ]).join('\n');
    throw new Error(
      `packages/runtime reaches into a host:\n${details}\n`
      + 'Inject the capability through ClaudeCodeDeps or HostEnvironment instead.',
    );
  }
  return entries.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const importCount = checkRuntimeHostBoundary();
    console.log(`[runtime-host-boundary] runtime source clean (${importCount} imports scanned).`);
  } catch (error) {
    console.error(`[runtime-host-boundary] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
