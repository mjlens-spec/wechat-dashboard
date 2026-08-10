#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '微信监督管理 for 舒舒';
const projectFolderName = 'WeChat-Dashboard';
const outputPath = join(projectRoot, `${packageName}.zip`);
const stagingRoot = mkdtempSync(join(tmpdir(), 'wechat-shushu-package-'));
const packageRoot = join(stagingRoot, packageName);
const packagedProject = join(packageRoot, projectFolderName);
const tempZip = join(projectRoot, `.${packageName}-${process.pid}.zip`);
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: projectRoot,
  encoding: 'utf8',
}).trim();

try {
  mkdirSync(packagedProject, { recursive: true, mode: 0o700 });
  for (const path of trackedFiles()) {
    if (excludedFromHandoff(path)) continue;
    const source = join(projectRoot, path);
    const destination = join(packagedProject, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, lstatSync(source).mode & 0o777);
  }

  const templateDirectory = join(projectRoot, 'packaging', 'shushu');
  for (const name of readdirSync(templateDirectory)) {
    const source = join(templateDirectory, name);
    const destination = join(packageRoot, name.replace(/\.template$/, ''));
    const content = readFileSync(source, 'utf8')
      .replaceAll('{{VERSION}}', packageJson.version)
      .replaceAll('{{COMMIT}}', commit);
    writeFileSync(destination, content, { mode: name.includes('.command') ? 0o755 : 0o600 });
  }

  writeFileSync(join(packageRoot, 'SHA256SUMS.txt'), checksumManifest(packageRoot), {
    mode: 0o600,
  });

  rmSync(tempZip, { force: true });
  execFileSync('/usr/bin/zip', ['-qry', tempZip, packageName], { cwd: stagingRoot });
  renameSync(tempZip, outputPath);

  process.stdout.write(`${JSON.stringify({
    status: 'packaged',
    version: packageJson.version,
    commit,
    output: outputPath,
    bytes: lstatSync(outputPath).size,
    files: walkFiles(packageRoot).length,
  }, null, 2)}\n`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
  try {
    unlinkSync(tempZip);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function excludedFromHandoff(path) {
  return path === 'WeChat_Dashboard_Context_Handoff_OC_0809[A].md';
}

function checksumManifest(root) {
  return `${walkFiles(root)
    .filter((path) => basename(path) !== 'SHA256SUMS.txt')
    .map((path) => {
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      return `${digest}  ${relative(root, path)}`;
    })
    .join('\n')}\n`;
}

function walkFiles(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}
