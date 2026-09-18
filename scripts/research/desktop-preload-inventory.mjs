// Read-only first-party source inventory. Never executes preload, Electron, or native modules.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRELOAD_SHA256 = '9c7b19aaeacb6887a84785f1273e61e4fa9ca78d17f51cabf393e4664bd15c70';

export function inventoryPreload(source) {
  const ast = ts.createSourceFile('preload.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('Preload source has syntax errors');
  // Bind symbols in this one in-memory file; never read imports or execute the source.
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = name => name === 'preload.js' ? ast : undefined;
  host.fileExists = name => name === 'preload.js';
  host.readFile = () => undefined;
  const checker = ts.createProgram(['preload.js'], { allowJs: true, noLib: true, noResolve: true }, host).getTypeChecker();
  const constants = new Map();
  const calls = [];
  let rootBlock;
  function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
  walk(ast, node => {
    if (!rootBlock && ts.isArrowFunction(node) && ts.isBlock(node.body)) rootBlock = node.body;
    // Only immutable aliases declared in the preload IIFE.
    if (ts.isVariableDeclaration(node) && node.parent.parent.parent === rootBlock
      && (node.parent.flags & ts.NodeFlags.Const)
      && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer)) {
      constants.set(node, node.initializer.text);
    }
  });
  walk(ast, node => {
    if (!ts.isCallExpression(node)) return;
    const match = /^e\.ipcRenderer\.([A-Za-z]+)$/.exec(node.expression.getText(ast));
    if (!match) return;
    const argument = node.arguments[0];
    let owner = node.parent;
    while (owner && !ts.isPropertyAssignment(owner)) owner = owner.parent;
    const channel = argument && (ts.isStringLiteral(argument) ? argument.text
      : ts.isIdentifier(argument) ? constants.get(checker.getSymbolAtLocation(argument)?.valueDeclaration) : undefined);
    calls.push({ method: owner?.name.getText(ast) ?? null, kind: match[1], channel: channel ?? null,
      channelExpression: argument?.getText(ast) ?? null,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
  });
  return { sha256: createHash('sha256').update(source).digest('hex'), callCount: calls.length,
    channelCount: new Set(calls.map(call => call.channel).filter(Boolean)).size,
    unresolved: calls.filter(call => !call.method || !call.channel), calls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/research/desktop-preload-inventory.mjs /path/to/preload.js');
  const result = inventoryPreload(readFileSync(process.argv[2], 'utf8'));
  if (result.sha256 !== PRELOAD_SHA256) throw new Error('Unknown preload hash: inspect the source before changing the inventory contract');
  // This pinned version has one deliberately dynamic menu callback channel.
  if (result.unresolved.length !== 1 || result.unresolved[0].method !== 'onMenuClick'
    || result.unresolved[0].kind !== 'once' || result.unresolved[0].channelExpression !== 'n') {
    throw new Error('Unexpected unresolved IPC call sites require source review');
  }
  process.stdout.write(JSON.stringify(result));
}
