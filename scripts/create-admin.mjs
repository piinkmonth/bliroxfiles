#!/usr/bin/env node
/**
 * Create the first admin account.
 *
 * There is no open signup and no invite exists yet, so this is the only way to
 * get an account on a fresh install. After this, everyone else joins through
 * an invite generated in the admin panel.
 *
 *   node scripts/create-admin.mjs <username> [email]
 *
 * The password is read from stdin so it never lands in shell history.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'

// --- Load .env files the way Next.js does, so paths match the running app ---
function loadEnv() {
  for (const file of ['.env.production', '.env.local', '.env']) {
    const p = path.resolve(process.cwd(), file)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line)
      if (!match) continue
      const [, key, raw = ''] = match
      if (process.env[key] !== undefined) continue
      process.env[key] = raw.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
    }
  }
}
loadEnv()

const STORAGE_ROOT = process.env.BLIROX_STORAGE_ROOT || '/mnt/blirox-files'
const DB_PATH = path.join(STORAGE_ROOT, 'db', 'files.db')
const DEFAULT_QUOTA_GB = Number(process.env.BLIROX_DEFAULT_QUOTA_GB || 45)

// --- Must match hashPassword() in lib/auth.ts exactly ----------------------
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 }

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  })
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$')
}

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
function newId(len = 20) {
  let out = ''
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      const v = b & 31
      if (v < ALPHABET.length) {
        out += ALPHABET[v]
        if (out.length === len) break
      }
    }
  }
  return out
}

const IS_TTY = Boolean(process.stdin.isTTY)

/**
 * Build something that can answer a sequence of prompts.
 *
 * The two input modes need genuinely different handling. A terminal delivers
 * lines as they are typed, so sequential readline questions work. Piped input
 * arrives and ends all at once — readline emits every line immediately, and
 * any line without a question already waiting on it is dropped on the floor.
 * So for pipes we drain stdin first and serve answers from that list.
 */
async function makePrompter() {
  if (!IS_TTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const lines = Buffer.concat(chunks).toString('utf8').split('\n')
    let cursor = 0

    return {
      async ask(question) {
        if (cursor >= lines.length) {
          throw new Error(`Ran out of piped input at prompt: ${question.trim()}`)
        }
        process.stdout.write(`${question}\n`)
        return lines[cursor++].trim()
      },
      close() {},
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  return {
    ask(question, { hidden = false } = {}) {
      return new Promise((resolve) => {
        if (!hidden) {
          rl.question(question, resolve)
          return
        }

        // Mask the password as it is typed.
        const onData = () => {
          readline.clearLine(process.stdout, 0)
          readline.cursorTo(process.stdout, 0)
          process.stdout.write(question + '*'.repeat(rl.line.length))
        }
        process.stdin.on('data', onData)

        rl.question(question, (answer) => {
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(answer)
        })
      })
    },
    close() {
      rl.close()
    },
  }
}

async function main() {
  const username = process.argv[2]
  const email = process.argv[3] ?? null

  if (!username) {
    console.error('Usage: node scripts/create-admin.mjs <username> [email]')
    process.exit(1)
  }

  if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
    console.error('Username must be 3-24 characters: letters, numbers, underscores, hyphens.')
    process.exit(1)
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`\nNo database at ${DB_PATH}.`)
    console.error('Start the app once so it can create the schema, then run this again.')
    console.error(`(Storage root is ${STORAGE_ROOT} — is the drive mounted?)\n`)
    process.exit(1)
  }

  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) {
    console.error(`A user named "${username}" already exists.`)
    process.exit(1)
  }

  const prompter = await makePrompter()
  let password, confirm
  try {
    password = await prompter.ask(`Password for ${username}: `, { hidden: true })
    confirm = await prompter.ask('Confirm password: ', { hidden: true })
  } finally {
    prompter.close()
  }

  if (password.length < 10) {
    console.error('Password must be at least 10 characters.')
    process.exit(1)
  }

  if (password !== confirm) {
    console.error('Passwords did not match.')
    process.exit(1)
  }

  const id = newId()
  const now = Date.now()

  db.prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, status, quota_bytes, used_bytes, created_at)
     VALUES (?, ?, ?, ?, 'admin', 'active', ?, 0, ?)`,
  ).run(id, username, email, hashPassword(password), DEFAULT_QUOTA_GB * 1024 ** 3, now)

  db.prepare(
    `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'user.create_admin', 'user', ?, ?, ?)`,
  ).run(id, username, id, JSON.stringify({ via: 'scripts/create-admin.mjs' }), now)

  console.log(`\n✓ Admin "${username}" created.`)
  console.log(`  Sign in, then generate invites from /admin/invites.\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
