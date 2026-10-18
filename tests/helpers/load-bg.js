'use strict';
// Runs one src/bg/*.js file in a fresh vm context shaped like an extension background:
// `self` is the global, `chrome` is whatever the test passes, console output is recorded.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBg(file, extras = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bg', file), 'utf8');
  const logs = [];
  const rec = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') });
  const sandbox = Object.assign(
    { console: { info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('log') } },
    extras,
  );
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  // run(code) evaluates inside the context. Use it for anything compared with the context's
  // own global: from the host, `sandbox.window` is the context's global proxy, not `sandbox`
  // (Node substitutes the proxy whenever a global property holds the sandbox). Objects created
  // inside the context carry that context's prototypes, so compare them from the host only
  // after structuredClone(), or compare primitives.
  const run = (code) => vm.runInContext(code, sandbox);
  return { sandbox, logs, run };
}

module.exports = { loadBg };
