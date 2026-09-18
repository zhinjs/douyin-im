'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { decode } = require('./desktop-dtrait-core-decode.cjs');
const {
  runScenario,
  scenarios,
} = require('./desktop-dtrait-transport-fixture.cjs');
const { source } = decode(
  process.argv[2] || '/private/tmp/desktop-dtrait-core-1.0.31.js'
);
const raw =
  '"use strict";' +
  source.slice(106829, 116114) +
  ';globalThis.Transport=p;globalThis.parseHeaders=u;';
const original = realm => {
  const context = vm.createContext(realm);
  vm.runInContext(raw, context, { timeout: 1000 });
  return callbacks => {
    context.options = callbacks;
    vm.runInContext('new Transport(options)', context, { timeout: 1000 });
  };
};
(async () => {
  const sdk = await import(
    path.resolve('lib/anti-bot/desktop-dtrait-transport.js')
  );
  for (const [index, scenario] of scenarios.entries()) {
    assert.deepEqual(
      await runScenario(sdk.createDesktopDTraitTransportInstaller, scenario),
      await runScenario(original, scenario),
      `scenario ${index}: ${JSON.stringify(scenario)}`
    );
  }
  const context = vm.createContext({ window: {} });
  vm.runInContext(raw, context, { timeout: 1000 });
  const headers = [
    '',
    'NoColon\nX: a:b\nX: c',
    'Content-Type:\nContent-Type: second\nContent-Type: third',
    'Set-Cookie: a\nSet-Cookie: b',
    'constructor: x\n__proto__: y',
  ];
  for (const value of headers)
    assert.equal(
      JSON.stringify(sdk.parseDesktopDTraitResponseHeaders(value)),
      JSON.stringify(context.parseHeaders(value))
    );
  console.log(
    JSON.stringify({
      scenarios: scenarios.length,
      headerCases: headers.length,
      externalNetwork: false,
    })
  );
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
