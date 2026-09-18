// Compile-only: verifies real lib.dom Window can be passed without a caller cast; never opens a browser.
const ts = require('typescript');
const { resolve } = require('node:path');
const file = resolve('desktop-dtrait-browser-type-probe.ts');
const source = `
import { createDesktopDTraitBrowserCollector, createDesktopDTraitBrowserCore, type DesktopDTraitBrowserCoreOptions } from './src/anti-bot/desktop-dtrait-browser.js';
import { createDesktopDTraitTransportInstaller } from './src/anti-bot/desktop-dtrait-transport.js';
import { installDesktopDTraitBrowser, type DesktopDTraitBrowserDependencies } from './src/anti-bot/desktop-dtrait-browser-install.js';
import { createDesktopDTraitBrowserBootstrap, type DesktopDTraitBrowserBootstrapOptions } from './src/anti-bot/desktop-dtrait-browser-bootstrap.js';
import { createDesktopWebSecureBrowser, startDesktopLoginWebSecure, type DesktopWebSecureBrowserOptions } from './src/anti-bot/desktop-web-secure-browser.js';
declare const realm: Window & typeof globalThis;
declare const options: DesktopDTraitBrowserCoreOptions;
declare const dependencies: DesktopDTraitBrowserDependencies;
declare const bootstrapOptions: DesktopDTraitBrowserBootstrapOptions;
declare const secureOptions: DesktopWebSecureBrowserOptions;
createDesktopDTraitBrowserCollector(realm);
createDesktopDTraitBrowserCore(realm, options);
createDesktopDTraitTransportInstaller(realm);
installDesktopDTraitBrowser(realm, dependencies);
createDesktopDTraitBrowserBootstrap(realm, bootstrapOptions);
createDesktopWebSecureBrowser(realm, secureOptions);
startDesktopLoginWebSecure(realm, secureOptions, { aid: 339757, device_id: 'synthetic' });
`;
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  noEmit: true,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
};
const host = ts.createCompilerHost(options),
  read = host.readFile,
  exists = host.fileExists;
host.readFile = path => (path === file ? source : read(path));
host.fileExists = path => path === file || exists(path);
const program = ts.createProgram([file], options, host);
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: x => x,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    })
  );
  process.exitCode = 1;
} else
  console.log(
    'PASS real DOM Window accepts collector/core/transport/bootstrap/WebSecure without caller casts'
  );
