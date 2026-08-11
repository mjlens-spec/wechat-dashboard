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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productName = '微信飞书消息分析 Dashboard';
const projectFolderName = 'wechat-feishu-message-analysis-dashboard';
const releaseDirectory = join(projectRoot, '交付包');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const packageRootName = `${projectFolderName}-v${packageJson.version}`;
const readerTroubleshootingSource = join(
  projectRoot,
  '移交资料',
  '微信本机数据读取接入与排障经验_OC_0811[A].md',
);
const baseCommit = git(['rev-parse', 'HEAD']).trim();
const sourceState = git(['status', '--porcelain=v1', '--untracked-files=all']).trim()
  ? 'working-tree-snapshot'
  : 'clean-commit';
const stagingRoot = mkdtempSync(join(tmpdir(), 'wechat-feishu-transfer-'));
const packageRoot = join(stagingRoot, packageRootName);
const packagedProject = join(packageRoot, projectFolderName);

assertNoUnmergedPaths();
mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
const artifactStem = nextArtifactStem(packageJson.version);
const outputPath = join(releaseDirectory, `${artifactStem}.zip`);
const checksumPath = `${outputPath}.sha256`;
const tempZip = join(stagingRoot, `${artifactStem}.zip`);

try {
  mkdirSync(packagedProject, { recursive: true, mode: 0o700 });
  const included = workingTreeFiles().filter((path) => !excludedFromTransfer(path));
  for (const path of included) {
    const source = join(projectRoot, path);
    const destination = join(packagedProject, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, lstatSync(source).mode & 0o777);
    assertSameFile(source, destination);
  }

  const templateDirectory = join(projectRoot, 'packaging', 'transfer');
  for (const name of readdirSync(templateDirectory)) {
    const source = join(templateDirectory, name);
    const destination = join(packageRoot, name.replace(/\.template$/, ''));
    const content = readFileSync(source, 'utf8')
      .replaceAll('{{VERSION}}', packageJson.version)
      .replaceAll('{{COMMIT}}', baseCommit)
      .replaceAll('{{SOURCE_STATE}}', sourceState);
    writeFileSync(destination, content, {
      mode: name.includes('.command') ? 0o755 : 0o600,
    });
  }

  copyFileSync(
    readerTroubleshootingSource,
    join(packageRoot, 'WECHAT_READER_TROUBLESHOOTING.md'),
  );

  writeFileSync(
    join(packageRoot, 'RELEASE_MANIFEST.json'),
    `${JSON.stringify({
      product: productName,
      version: packageJson.version,
      baseCommit,
      sourceState,
      sourceSnapshotSha256: snapshotDigest(packagedProject),
      createdAt: new Date().toISOString(),
      target: 'macOS',
      sourceFolder: projectFolderName,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(packageRoot, 'SOURCE_FILES.json'),
    `${JSON.stringify({
      sourceFolder: projectFolderName,
      files: included,
      preserveOnUpgrade: [
        '.env*',
        '.runtime/',
        '.next/',
        'node_modules/',
        '.upgrade-backups/',
        '~/.wechat-dashboard/',
        '~/.wx-cli/',
        'macOS Keychain',
      ],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(packageRoot, 'SHA256SUMS.txt'), checksumManifest(packageRoot), {
    mode: 0o600,
  });

  verifyGeneratedScripts(packageRoot);
  verifyChecksumManifest(packageRoot);
  execFileSync('/usr/bin/zip', ['-qry', tempZip, packageRootName], { cwd: stagingRoot });
  execFileSync('/usr/bin/unzip', ['-tqq', tempZip]);
  verifyArchiveContents(tempZip);
  renameSync(tempZip, outputPath);

  const zipDigest = sha256(outputPath);
  writeFileSync(checksumPath, `${zipDigest}  ${basename(outputPath)}\n`, { mode: 0o600 });

  process.stdout.write(`${JSON.stringify({
    status: 'packaged',
    product: productName,
    version: packageJson.version,
    baseCommit,
    sourceState,
    output: outputPath,
    checksum: checksumPath,
    sha256: zipDigest,
    bytes: lstatSync(outputPath).size,
    sourceFiles: included.length,
    packageFiles: walkFiles(packageRoot).length,
  }, null, 2)}\n`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

function git(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function assertNoUnmergedPaths() {
  const unmerged = git(['diff', '--name-only', '--diff-filter=U']).trim();
  if (unmerged) throw new Error('Refusing to package a worktree with unresolved merge conflicts.');
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function workingTreeFiles() {
  const tracked = trackedFiles();
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(allowedUntrackedSource);
  return [...new Set([...tracked, ...untracked])].sort((left, right) =>
    left.localeCompare(right, 'zh-CN'),
  );
}

function allowedUntrackedSource(path) {
  return (
    path.startsWith('app/api/keywords/') ||
    path.startsWith('app/keywords/') ||
    path === 'lib/keyword-tracking-policy.mjs' ||
    path === 'lib/keyword-tracking.ts' ||
    path === 'lib/update-cadence.mjs' ||
    path === 'scripts/verify-keyword-tracking.mjs' ||
    path === 'packaging/transfer/CODEX_UPGRADE.md.template'
  );
}

function excludedFromTransfer(path) {
  return (
    path === 'WeChat_Dashboard_Context_Handoff_OC_0809[A].md' ||
    path.startsWith('移交资料/')
  );
}

function nextArtifactStem(version) {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  for (let index = 0; index < 26; index += 1) {
    const revision = String.fromCharCode(65 + index);
    const stem = `wechat-feishu-message-analysis-dashboard-v${version}_OC_${mmdd}[${revision}]`;
    try {
      lstatSync(join(releaseDirectory, `${stem}.zip`));
    } catch (error) {
      if (error?.code === 'ENOENT') return stem;
      throw error;
    }
  }
  throw new Error('No available artifact revision from A to Z.');
}

function verifyGeneratedScripts(root) {
  for (const name of ['INSTALL.command', 'CHECK.command', 'RUNTIME.zsh']) {
    execFileSync('/bin/zsh', ['-n', join(root, name)]);
  }
}

function verifyChecksumManifest(root) {
  const expected = checksumManifest(root);
  const actual = readFileSync(join(root, 'SHA256SUMS.txt'), 'utf8');
  if (actual !== expected) throw new Error('Internal checksum manifest verification failed.');
}

function verifyArchiveContents(path) {
  const entries = execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const normalizedEntries = new Set(entries.map((entry) => entry.normalize('NFC')));
  const required = [
    `${packageRootName}/README_FIRST.md`,
    `${packageRootName}/AGENTS.md`,
    `${packageRootName}/CODEX_UPGRADE.md`,
    `${packageRootName}/INSTALL.command`,
    `${packageRootName}/CHECK.command`,
    `${packageRootName}/RUNTIME.zsh`,
    `${packageRootName}/INSTALLATION_GUIDE.md`,
    `${packageRootName}/CONNECT_WECHAT_FEISHU.md`,
    `${packageRootName}/SHA256SUMS.txt`,
    `${packageRootName}/SOURCE_FILES.json`,
    `${packageRootName}/${projectFolderName}/package.json`,
    `${packageRootName}/${projectFolderName}/pnpm-lock.yaml`,
    `${packageRootName}/${projectFolderName}/TRANSFER.md`,
    `${packageRootName}/${projectFolderName}/lib/feishu.ts`,
    `${packageRootName}/${projectFolderName}/lib/feishu-sync.ts`,
    `${packageRootName}/${projectFolderName}/app/opportunities/page.tsx`,
    `${packageRootName}/${projectFolderName}/app/api/keywords/route.ts`,
    `${packageRootName}/${projectFolderName}/app/keywords/[id]/page.tsx`,
    `${packageRootName}/${projectFolderName}/lib/update-cadence.mjs`,
    `${packageRootName}/WECHAT_READER_TROUBLESHOOTING.md`,
  ];
  for (const entry of required) {
    if (!normalizedEntries.has(entry.normalize('NFC'))) {
      throw new Error(`Required archive entry missing: ${entry}`);
    }
  }
  for (const entry of entries) {
    const normalized = entry.normalize('NFC');
    const segments = normalized.split('/');
    if (
      segments.includes('.git') ||
      segments.includes('node_modules') ||
      segments.includes('.next') ||
      segments.includes('.runtime') ||
      segments.includes('.local-debug') ||
      segments.includes('.playwright-cli') ||
      segments.includes('.upgrade-backups') ||
      segments.includes('交付包') ||
      normalized.includes('WeChat_Dashboard_Context_Handoff') ||
      /(^|\/)\.env(?:\.|$)/.test(normalized) && !normalized.endsWith('/.env.example') ||
      /\.(?:db|sqlite|sqlite3|log|zip)$/i.test(normalized)
    ) {
      throw new Error(`Forbidden archive entry: ${entry}`);
    }
  }
}

function snapshotDigest(root) {
  return createHash('sha256').update(checksumManifest(root)).digest('hex');
}

function assertSameFile(source, destination) {
  if (sha256(source) !== sha256(destination)) {
    throw new Error(`Copied file differs from source: ${relative(projectRoot, source)}`);
  }
}

function checksumManifest(root) {
  return `${walkFiles(root)
    .filter((path) => basename(path) !== 'SHA256SUMS.txt')
    .map((path) => `${sha256(path)}  ${relative(root, path)}`)
    .join('\n')}\n`;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
