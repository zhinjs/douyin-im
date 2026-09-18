// Test-only browser loader for actual production modules; rejects Node dependencies.
const path = require('node:path');
const { compileBrowserModules } = require('../build/browser-bundle.cjs');
module.exports = function browserModules(entries) {
  return compileBrowserModules(path.join(__dirname, '../../src/anti-bot'), entries) + '\nconst fixtureRequire=load;';
};
