#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { program } = require('playwright-core/lib/utilsBundle');
const { tools, libCli } = require('playwright-core/lib/coreBundle');

if (process.argv.includes('install-browser')) {
  const argv = process.argv.map(arg => arg === 'install-browser' ? 'install' : arg);
  libCli.decorateProgram(program);
  void program.parseAsync(argv);
  return;
}

const packageJSON = require('./package.json');
const { ViriumServer } = require('./src/virium-mcp.js');
const { ensureEnvironmentReady } = require('./src/vm/setup-environment.js');

if (process.argv.includes('install-vm')) {
  ensureEnvironmentReady()
    .then((res) => {
      console.log('[Virium] Environment ready:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Virium Error] Environment setup failed:', err);
      process.exit(1);
    });
  return;
}

if (process.argv.includes('--use-vm')) {
  ensureEnvironmentReady().then(() => {
    const server = new ViriumServer({ useVm: true });
    return server.listen();
  }).catch(err => {
    console.error('[Virium Error]', err);
    process.exit(1);
  });
} else {
  const p = program.version('Version ' + packageJSON.version).name('Playwright MCP (Virium)');
  tools.decorateMCPCommand(p, packageJSON.version);
  void program.parseAsync(process.argv);
}

