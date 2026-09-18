const { jest: jestObject } = require('@jest/globals');

// Jest 29 does not inject the `jest` helper into native ESM modules.
// Keep the existing test API while the project and its dependencies run as ESM.
globalThis.jest = jestObject;
