#!/usr/bin/env node
// Downloads a pinned nats-server release into bin/ and verifies it against the
// SHA-256 hashes pinned below, so a changed release can't vouch for itself.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v2.15.2';
// From this release's SHA256SUMS. Update them together with VERSION.
const SHA256 = {
  'darwin-amd64': '9c45b23c19498692e81cd39c75e8382f0e6ff59c0d5b9470e32fe6640afa4446',
  'darwin-arm64': 'cbd2219d01502c38733485ac684269da585ee479fa3b1377264beecdefdf9e9d',
  'linux-amd64': '67cb8e10bc6f0c4b47f75a728529a20953dbae2a4f9a4a52ae8517d65ae303ff',
  'linux-arm64': 'bc2c788dcbf2849af749564e06a0d48c19bced851f2d68a2e21c54d078949b28',
  'windows-amd64': 'f6398d5d11093778f870db70242cb50d20a58134c937c805ba8d114e7e398766',
  'windows-arm64': '0c688b55a074b48289b84edc8b68936421c00cef7bb5ae589ef48e5f8e6a161d',
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const target = join(root, 'bin', isWindows ? 'nats-server.exe' : 'nats-server');

if (existsSync(target)) {
  console.log(`nats-server already present: ${target}`);
  process.exit(0);
}

const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!os || !arch) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);

const stem = `nats-server-${VERSION}-${os}-${arch}`;
const asset = `${stem}.${isWindows ? 'zip' : 'tar.gz'}`;
const base = `https://github.com/nats-io/nats-server/releases/download/${VERSION}`;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

console.log(`Downloading ${asset}`);
const archive = await download(`${base}/${asset}`);

const expected = SHA256[`${os}-${arch}`];
const actual = createHash('sha256').update(archive).digest('hex');
if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}: ${actual} != ${expected}`);
console.log(`Checksum OK: ${actual}`);

const work = mkdtempSync(join(tmpdir(), 'agentbus-nats-'));
try {
  const archivePath = join(work, asset);
  writeFileSync(archivePath, archive);
  // bsdtar ships with Windows 10+ and reads both formats.
  const tar = isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archivePath, '-C', work], { stdio: 'inherit' });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(work, stem, isWindows ? 'nats-server.exe' : 'nats-server'), target);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Installed ${target}`);
