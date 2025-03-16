// This is a simplified test script that directly calls our index.js with mocked inputs
const path = require('path');

// Mock the necessary modules before requiring index.js
process.env.INPUT_ACTION_REF = 'actions/hello-world-javascript-action@main';
process.env.INPUT_EXTRA_ARGS = '';

// Mock @actions/core
jest.mock('@actions/core', () => ({
  getInput: (name) => {
    if (name === 'action-ref') return process.env.INPUT_ACTION_REF;
    if (name === 'extra-args') return process.env.INPUT_EXTRA_ARGS;
    return '';
  },
  info: (msg) => console.log(`[INFO] ${msg}`),
  setFailed: (msg) => {
    console.error(`[FAILED] ${msg}`);
    process.exit(1);
  }
}));

// Now run the actual action
require('./index');