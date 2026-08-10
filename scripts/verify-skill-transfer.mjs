#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'wechat-dashboard-skill-verify-'));
const codexSkillsDirectory = join(temporaryRoot, 'codex-skills');
const target = join(codexSkillsDirectory, 'wechat-dashboard');
const installer = join(projectRoot, 'scripts', 'install-agent-skills.mjs');

try {
  run(['--codex-only', '--codex-skills-dir', codexSkillsDirectory]);
  const checked = JSON.parse(
    run(['--check', '--codex-only', '--codex-skills-dir', codexSkillsDirectory]),
  );
  if (checked.status !== 'verified') throw new Error('Isolated Skill check did not verify.');
  if (!lstatSync(target).isSymbolicLink()) throw new Error('Isolated Skill target is not a symlink.');
  if (realpathSync(target) !== realpathSync(join(projectRoot, 'skills', 'wechat-dashboard'))) {
    throw new Error('Isolated Skill symlink points to the wrong source.');
  }
  const skill = readFileSync(join(target, 'SKILL.md'), 'utf8');
  if (!skill.includes('gpt-5.6-terra') || !skill.includes('reasoning `high`')) {
    throw new Error('Terra High contract is missing from installed Skill.');
  }
  const wrapper = join(target, 'scripts', 'run-bridge.zsh');
  if ((lstatSync(wrapper).mode & 0o111) === 0) {
    throw new Error('Skill runtime wrapper is not executable.');
  }
  execFileSync('/bin/zsh', ['-n', wrapper]);
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    host: 'codex',
    isolated: true,
    source: realpathSync(target),
  }, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(args) {
  return execFileSync(process.execPath, [installer, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}
