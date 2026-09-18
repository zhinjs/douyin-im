// Execute only pinned core class/VM functions with explicitly supplied synthetic dependencies.
// Never evaluates the bundle entrypoint, polyfills, transport, collector or feature implementation.
const vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const { decode } = require('./desktop-dtrait-core-decode.cjs');
function createRawCore(path, dependencies) {
  const decoded = decode(path), source = decoded.source;
  const ast = ts.createSourceFile('core.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), declarations = {};
  function visit(node) { if (ts.isFunctionDeclaration(node) && ['it', 'at'].includes(node.name?.text) && node.getStart(ast) > 148000) declarations[node.name.text] = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(declarations.it && declarations.at);
  const helperStart = source.indexOf('function t(t,e,r,n,o,i,a)'), helperEnd = source.indexOf('r.r(n)', helperStart); assert.ok(helperStart > 0 && helperEnd > helperStart);
  const context = vm.createContext({ ...dependencies.globals, et: decoded.functions.map(f => [f.code, f.argc, f.strict, f.trys]), tt: decoded.strings, rt: new Map(), nt: new Map() });
  vm.runInContext(source.slice(helperStart, helperEnd) + declarations.it + declarations.at + ';globalThis.make=it;globalThis.asyncWrap=e;', context);
  // F1's enclosing scope: async helper, transport, feature protocol, collector, version.
  const outer = [context.asyncWrap, dependencies.Transport, dependencies.FeatureProtocol, dependencies.collect, '1.0.31', dependencies.clearCollectionErrors, dependencies.getCollectionErrors];
  context.make(1, outer)();
  const core = dependencies.construct === false ? undefined : new outer[7](dependencies.params);
  return { core, Core: outer[7], context, decoded };
}
module.exports = { createRawCore };
