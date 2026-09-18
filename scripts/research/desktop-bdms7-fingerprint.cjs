// Dev-only loader for the production fingerprint builder; no duplicated algorithm.
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const moduleExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-fingerprint.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {exports:moduleExports},{timeout:3000,filename:'production-desktop-fingerprint.js'});
module.exports={buildDesktopFingerprint:moduleExports.buildDesktopFingerprint};
