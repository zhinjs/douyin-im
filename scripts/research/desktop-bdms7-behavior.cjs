// Dev-only adapter around the production state model; no duplicate q algorithm.
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const moduleExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname,'../../src/anti-bot/desktop-behavior.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {exports:moduleExports},{timeout:3000,filename:'production-desktop-behavior.js'});
class BehaviorState extends moduleExports.DesktopBehaviorState {
  constructor(startPerformanceTime=0) {super(startPerformanceTime);}
  accept(event) {
    if(event.type==='keydown')this.recordKeydown(event.ts);
    else if(event.type==='mousemove')this.recordMove(event);
    else if(event.type==='mousedown')this.recordClickStart(event);
  }
}
module.exports={BehaviorState};
