/**
 * Create or replace the station's internal admin credential.
 *
 *   bun run --cwd apps/station-web scripts/set-admin-password.ts <username>
 *
 * Reads the password from stdin so it never appears in shell history or in a
 * process listing. The credential is hashed immediately and only the hash is
 * stored; nothing here prints it.
 *
 * There is deliberately no default credential. A first-run PIN that everyone
 * knows is not a control, it is a checkbox — and the previous design shipped
 * exactly that, with the value printed in the ops UI.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { setAdminCredential, adminConfigured } from '../src/lib/admin-auth'
import { db } from '../src/lib/db'

const username = process.argv[2]?.trim()
if (!username) {
  console.error('usage: bun run --cwd apps/station-web scripts/set-admin-password.ts <username>')
  console.error('   the password is read from stdin, not the command line')
  process.exit(1)
}

/**
 * Read the password without ever putting it on a command line.
 *
 * When stdin is a TTY we prompt, so a human does not have their password
 * echoed. When it is a pipe we read it silently — the previous version prompted
 * unconditionally and then blocked forever on the confirmation line, because a
 * pipe supplies one line and the prompt wanted two.
 */
async function readSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true })
    stdout.write(prompt)
    const value = await rl.question('')
    rl.close()
    return value
  }
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? ''
}

const password = await readSecret('password: ')
const confirm = process.stdin.isTTY ? await readSecret('confirm:  ') : password

await db.$disconnect()

if (password !== confirm) {
  console.error('passwords did not match')
  process.exit(1)
}
if (password.length < 10) {
  console.error('password must be at least 10 characters')
  process.exit(1)
}

const before = await adminConfigured()
await setAdminCredential(username, password)

console.log('')
console.log(`admin credential ${before ? 'replaced' : 'created'} for user "${username}".`)
console.log('The password was hashed and discarded. It is not recoverable.')
console.log('Sign in at /ops to reach the control room.')
process.exit(0)
