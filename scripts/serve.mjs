#!/usr/bin/env node
/**
 * Start the app, clearing a stale instance off the port first.
 *
 *   node scripts/serve.mjs start [--port 4001] [--force]
 *   node scripts/serve.mjs dev   [--port 4001] [--force]
 *
 * Blindly killing whatever holds a port is a good way to take down something
 * that matters — a database, an SSH tunnel, another project's dev server. So
 * this identifies the process first and only kills it when it is demonstrably
 * *this* app. Anything else is reported and the script stops, leaving the
 * decision to a human. --force overrides that, deliberately awkwardly.
 */

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const mode = args[0] === 'dev' ? 'dev' : 'start'
const force = args.includes('--force')

const portFlag = args.indexOf('--port')
const PORT = Number(
  portFlag !== -1 ? args[portFlag + 1] : (process.env.PORT ?? 4001),
)

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid port: ${PORT}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Who is on the port
// ---------------------------------------------------------------------------

function listenerPids(port) {
  const pids = new Set()

  // ss is present on essentially every modern Linux; -H drops the header.
  try {
    const out = execSync(`ss -tlnpH 'sport = :${port}' 2>/dev/null`, { encoding: 'utf8' })
    for (const match of out.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]))
  } catch {
    /* ss missing or no matches */
  }

  if (pids.size === 0) {
    try {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' })
      for (const line of out.split('\n')) {
        const pid = Number(line.trim())
        if (pid) pids.add(pid)
      }
    } catch {
      /* lsof missing or no matches */
    }
  }

  // Never target ourselves.
  pids.delete(process.pid)
  return [...pids]
}

function describe(pid) {
  let cwd = null
  let cmdline = ''
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    /* gone, or owned by another user */
  }
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch {
    /* same */
  }
  return { pid, cwd, cmdline }
}

/**
 * Is this process an instance of this app?
 *
 * Either it is running from this directory, or its command line names this
 * directory. Both are checked because a server started from a parent directory
 * still counts, and a same-named project elsewhere on disk does not.
 */
function isOurs({ cwd, cmdline }) {
  const mentionsNext = /\bnext(-server)?\b/.test(cmdline) || /next\/dist/.test(cmdline)
  if (!mentionsNext) return false
  return cwd === PROJECT_ROOT || cmdline.includes(PROJECT_ROOT)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function freePort(port) {
  const pids = listenerPids(port)
  if (pids.length === 0) return

  const infos = pids.map(describe)
  const mine = infos.filter(isOurs)
  const foreign = infos.filter((i) => !isOurs(i))

  if (foreign.length > 0 && !force) {
    console.error(`\n  Port ${port} is held by something that is not this app:\n`)
    for (const { pid, cwd, cmdline } of foreign) {
      console.error(`    pid ${pid}`)
      console.error(`      cwd: ${cwd ?? '(unreadable — different user?)'}`)
      console.error(`      cmd: ${(cmdline || '(unreadable)').slice(0, 120)}`)
    }
    console.error(`\n  Not killing it. Either stop it yourself, pick another port:`)
    console.error(`      npm start -- --port 4002`)
    console.error(`  or override if you are certain:`)
    console.error(`      npm start -- --force\n`)
    process.exit(1)
  }

  const targets = force ? infos : mine
  if (targets.length === 0) return

  console.log(`  Port ${port} is in use by a previous instance — stopping it.`)

  for (const { pid } of targets) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already exited */
    }
  }

  // Give it a chance to shut down cleanly; SQLite in particular would rather
  // checkpoint its WAL than be killed mid-write.
  for (let waited = 0; waited < 8000; waited += 200) {
    if (!targets.some(({ pid }) => alive(pid))) break
    await sleep(200)
  }

  const stubborn = targets.filter(({ pid }) => alive(pid))
  for (const { pid } of stubborn) {
    console.log(`  pid ${pid} ignored SIGTERM — sending SIGKILL.`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* raced with exit */
    }
  }

  await sleep(400)

  if (listenerPids(port).length > 0) {
    console.error(`  Could not free port ${port}. Try another with --port.`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------

await freePort(PORT)

const child = spawn(
  process.execPath,
  [path.join(PROJECT_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), mode, '-p', String(PORT)],
  { cwd: PROJECT_ROOT, stdio: 'inherit', env: process.env },
)

// Forward signals so Ctrl-C stops Next rather than orphaning it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})
