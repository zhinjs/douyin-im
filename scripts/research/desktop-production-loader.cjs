// Shared production dependency loader for standalone source-oracle fixtures.
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const cache={};
module.exports=function load(name){
  const id=name.replace(/^\.\//,'').replace(/\.js$/,'');
  if(cache[id])return cache[id];
  const exports=cache[id]={};
  const code=ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot',id+'.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  new Function('exports','require',code)(exports,dependency=>dependency.startsWith('.')?load(dependency):require(dependency));
  return exports;
};
