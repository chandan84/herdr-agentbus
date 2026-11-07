#!/usr/bin/env node
// Registers agentbus for this folder only: writes MCP registrations for Claude Code and
// Codex with this checkout's absolute path, plus the user's config file. Existing files
// are left alone. To use agentbus from any folder, run setup-global.mjs instead.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, DEFAULTS } from '../src/config.mjs';
import { projectFiles } from './project-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = {
  [CONFIG_PATH]: `${JSON.stringify(DEFAULTS, null, 2)}\n`,
  ...projectFiles(root),
};

for (const [name, content] of Object.entries(files)) {
  const path = resolve(root, name);
  if (existsSync(path)) {
    console.log(`Left alone (already exists): ${name}`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`Wrote ${name}`);
}
