/**
 * Copy the static assets and public/ into the standalone output.
 *
 * This used to be `cp -r ...` inline in the build script. On Windows `cp` is
 * not GNU cp, so the step failed with "illegal option -- r" and the standalone
 * server shipped without any static assets or public files. fs.cpSync does the
 * same job on every platform and reports a real error when a source is absent.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * On Vercel there is no standalone output to copy.
 *
 * `next.config.ts` disables `output: "standalone"` when VERCEL is set, and the
 * platform does its own bundling. This script exists for the self-host path, so
 * on Vercel it must exit successfully without copying anything — otherwise the
 * `next build && node scripts/copy-standalone.mjs` chain fails the deploy after
 * a perfectly good build, on the "standalone output missing" guard below.
 */
if (process.env.VERCEL) {
  console.log('VERCEL is set: standalone output is not produced; nothing to copy.')
  process.exit(0)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const standalone = join(root, '.next', 'standalone')

if (!existsSync(standalone)) {
  console.error(`standalone output missing at ${standalone}; did next build run?`)
  process.exit(1)
}

/**
 * Find the directory that actually holds `server.js`.
 *
 * In a monorepo, Next traces from the workspace root, so the standalone server
 * lands at `.next/standalone/<relative-app-path>/server.js` — for this app,
 * `.next/standalone/apps/station-web/server.js`. Copying static assets to the
 * standalone root (as this used to) put them one level too high, so the running
 * server served no CSS/JS. Discover the real location instead of hardcoding it.
 */
function findServerDir(dir) {
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()
    if (existsSync(join(d, 'server.js'))) return d
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
        stack.push(join(d, entry.name))
      }
    }
  }
  return null
}

const serverDir = findServerDir(standalone)
if (!serverDir) {
  console.error(`no server.js found under ${standalone}; did next build run?`)
  process.exit(1)
}

// Next's standalone output does not include these two trees.
const copies = [
  [join(root, '.next', 'static'), join(serverDir, '.next', 'static')],
  [join(root, 'public'), join(serverDir, 'public')],
]

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.warn(`skipping ${from}: does not exist`)
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
  console.log(`copied ${from} -> ${to}`)
}