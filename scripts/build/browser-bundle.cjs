// Build-only compiler: closed relative module graph, no runtime eval or Node shim.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');

function compileBrowserModules(root, entries) {
  const modules = new Map();
  function load(name) {
    if (!/^[\w-]+$/.test(name)) throw Error('Invalid browser module name: ' + name);
    if (modules.has(name)) return;
    const source = fs.readFileSync(path.join(root, name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true,
    }, reportDiagnostics: true });
    const errors = compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) || [];
    if (errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n',
    }));
    const code = compiled.outputText;
    modules.set(name, code);
    const ast = ts.createSourceFile(name + '.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (node.arguments.length !== 1 || !arg || !ts.isStringLiteral(arg) || !/^\.\/[\w-]+\.js$/.test(arg.text)) {
          throw Error('Non-browser dependency in ' + name + ': ' + node.getText(ast));
        }
        load(arg.text.slice(2, -3));
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw Error('Dynamic import is not supported in browser asset: ' + name);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  entries.forEach(load);
  return `const modules={${[...modules].map(([name, code]) => JSON.stringify(name) + ':function(exports,require){' + code + '\n}').join(',')}};
const cache=Object.create(null);
function load(name){
  name=name.replace(/^\\.\\//,'').replace(/\\.js$/,'');
  if(cache[name])return cache[name];
  const exports={};cache[name]=exports;
  if(!Object.prototype.hasOwnProperty.call(modules,name))throw Error('Unknown browser module: '+name);
  modules[name](exports,load);return exports;
}`;
}

function buildDesktopBdmsAsset(root) {
  return '(function(){\n' + compileBrowserModules(root, ['browser-entry']) + '\nload("browser-entry");\n})();\n';
}

function buildDesktopDTraitAsset(root) {
  return buildSecurityAsset(root, false);
}

function buildDesktopWebSecureAsset(root) {
  return buildSecurityAsset(root, true);
}

function buildSecurityAsset(root, includeWebSecure) {
  // Exact package versions are locked by pnpm. Evaluate the public browser builds lazily,
  // in this realm, at the source loader points. Never ship extracted application chunks.
  const jsencrypt = fs.readFileSync(require.resolve('jsencrypt'), 'utf8');
  const cryptojs = fs.readFileSync(require.resolve('crypto-js/crypto-js.js'), 'utf8');
  const entries = ['desktop-dtrait-browser-install', 'desktop-dtrait-browser-bootstrap'];
  if (includeWebSecure) entries.push('desktop-web-secure-browser');
  return '(function(){\n' + compileBrowserModules(root, entries) + `
const vendorFactories={
  rsa:function(module,exports){${jsencrypt}\n},
  aes:function(module,exports){${cryptojs}\n}
};
const vendorCache=Object.create(null);
function dependency(name){
  return Promise.resolve().then(function(){
    if(!Object.prototype.hasOwnProperty.call(vendorCache,name)){
      const module={exports:{}};vendorFactories[name](module,module.exports);
      vendorCache[name]=module.exports;
    }
    return vendorCache[name];
  });
}
if(globalThis.DouyinDTrait)throw new Error('DouyinDTrait already belongs to another browser owner');
${includeWebSecure ? "if(globalThis.DouyinWebSecure)throw new Error('DouyinWebSecure already belongs to another browser owner');" : ''}
const dependencies={
  loadCryptoJS:()=>dependency('aes'),
  loadJSEncrypt:()=>dependency('rsa').then(value=>({default:value.default||value}))
};
load('desktop-dtrait-browser-install').installDesktopDTraitBrowser(globalThis,dependencies);
globalThis.DouyinDTrait={
  createBootstrap:options=>load('desktop-dtrait-browser-bootstrap').createDesktopDTraitBrowserBootstrap(globalThis,{...options,...dependencies})
};
${includeWebSecure ? `globalThis.DouyinWebSecure={
  createSDK:options=>load('desktop-web-secure-browser').createDesktopWebSecureBrowser(globalThis,{...options,...dependencies}),
  startLogin:(config,options)=>load('desktop-web-secure-browser').startDesktopLoginWebSecure(globalThis,{...options,...dependencies},config)
};` : ''}
})();\n`;
}

module.exports = { compileBrowserModules, buildDesktopBdmsAsset, buildDesktopDTraitAsset, buildDesktopWebSecureAsset };
