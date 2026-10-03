/**
 * Copy the static assets and public/ into the standalone output.
 *
 * This used to be `cp -r ...` inline in the build script. On Windows `cp` is
 * not GNU cp, so the step failed with "illegal option -- r" and the standalone
 * server shipped without any static assets or public files. fs.cpSync does the
 * same job on every platform and reports a real error when a source is absent.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const standalone = join(root, '.next', 'standalone')

if (!existsSync(standalone)) {
  console.error(`standalone output missing at ${standalone}; did next build run?`)
  process.exit(1)
}

// Next's standalone output does not include these two trees.
const copies = [
  [join(root, '.next', 'static'), join(standalone, '.next', 'static')],
  [join(root, 'public'), join(standalone, 'public')],
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