#!/usr/bin/env node

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] || 'local'
const isWindows = process.platform === 'win32'

function printHelp() {
  console.log(`
EasyClaw packaging helper

Usage:
  npm run package:local
  npm run package:all
  node scripts/package.mjs local
  node scripts/package.mjs cloud

Modes:
  local   Build and package the current platform locally
  cloud   Trigger GitHub Actions to build both dmg and exe, then download artifacts
`)
}

function resolveCommand(command) {
  if (isWindows && (command === 'npm' || command === 'npx')) {
    return `${command}.cmd`
  }

  return command
}

function run(command, args, options = {}) {
  const executable = resolveCommand(command)
  console.log(`\n> ${[executable, ...args].join(' ')}`)
  execFileSync(executable, args, {
    cwd: rootDir,
    stdio: 'inherit',
    ...options
  })
}

function runJson(command, args) {
  const executable = resolveCommand(command)
  return execFileSync(executable, args, {
    cwd: rootDir,
    encoding: 'utf8'
  }).trim()
}

function hasCommand(command) {
  const checker = isWindows ? 'where' : 'which'
  return spawnSync(checker, [command], { stdio: 'ignore' }).status === 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getCurrentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: rootDir,
    encoding: 'utf8'
  }).trim()
}

function ensureGhCli() {
  if (!hasCommand('gh')) {
    console.error('需要先安装并登录 GitHub CLI (`gh auth login`) 才能触发云端打包。')
    process.exit(1)
  }
}

function buildCurrentPlatform() {
  run('npm', ['run', 'build'])

  if (process.platform === 'darwin') {
    run('npx', ['electron-builder', '--mac', '--publish', 'never'])
    console.log('\n已完成 macOS 打包，产物位于 dist/familyClaw.dmg')
    return
  }

  if (process.platform === 'win32') {
    run('npx', ['electron-builder', '--win', '--publish', 'never'])
    console.log('\n已完成 Windows 打包，产物位于 dist/familyClaw-setup.exe')
    return
  }

  console.error('当前只为 macOS 和 Windows 配置了本地安装包构建。')
  process.exit(1)
}

async function waitForWorkflowRun(branch) {
  const startedAt = Date.now()

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const output = runJson('gh', [
      'run',
      'list',
      '--workflow',
      'build-artifacts.yml',
      '--branch',
      branch,
      '--limit',
      '5',
      '--json',
      'databaseId,createdAt,url'
    ])

    const runs = JSON.parse(output)
    const run = runs.find((item) => {
      const createdAt = new Date(item.createdAt).getTime()
      return createdAt >= startedAt - 10_000
    })

    if (run) {
      return run
    }

    await sleep(3000)
  }

  console.error('未能在 GitHub Actions 中找到刚触发的构建任务。')
  process.exit(1)
}

async function triggerCloudBuild() {
  ensureGhCli()

  const branch = getCurrentBranch()
  console.log(`当前分支: ${branch}`)
  console.log('即将触发 GitHub Actions，同时构建 macOS dmg 和 Windows exe。')

  run('gh', ['workflow', 'run', 'build-artifacts.yml', '--ref', branch])

  const workflowRun = await waitForWorkflowRun(branch)
  console.log(`\n构建任务已创建: ${workflowRun.url}`)

  run('gh', ['run', 'watch', String(workflowRun.databaseId), '--exit-status'])

  const downloadDir = join(rootDir, 'dist', 'ci-artifacts', String(workflowRun.databaseId))
  if (existsSync(downloadDir)) {
    rmSync(downloadDir, { recursive: true, force: true })
  }
  mkdirSync(downloadDir, { recursive: true })

  run('gh', ['run', 'download', String(workflowRun.databaseId), '--dir', downloadDir])

  console.log(`\n已下载云端构建产物到 ${downloadDir}`)
}

async function main() {
  if (mode === 'help' || mode === '--help' || mode === '-h') {
    printHelp()
    return
  }

  if (mode === 'local') {
    buildCurrentPlatform()
    return
  }

  if (mode === 'cloud') {
    await triggerCloudBuild()
    return
  }

  console.error(`不支持的模式: ${mode}`)
  console.error('可用模式: local | cloud')
  process.exit(1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
