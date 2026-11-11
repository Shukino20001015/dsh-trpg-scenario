import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { openRegularRead } from './safe-read.js'

const DEFAULT_ROOT = fileURLToPath(new URL('.', import.meta.url))

async function readBounded(path, limit) {
  const handle = await openRegularRead(path)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error('插件文件不可核对')
    const data = await handle.readFile()
    if (data.length > limit) throw new Error('插件文件不可核对')
    return data
  } finally { await handle.close() }
}

// A fingerprint of package metadata and listed JS files on disk, not an
// attestation of already-loaded code, the DSH host or the selected model.
export async function scoringFileFingerprint(root = DEFAULT_ROOT) {
  const manifest = await readBounded(join(root, 'package.json'), 128 * 1024)
  const data = JSON.parse(manifest.toString('utf8'))
  if (!Array.isArray(data.files) || data.files.length > 200) throw new Error('插件清单不可核对')
  const files = data.files.filter(f => typeof f === 'string' && /\.(?:js|mjs)$/.test(f))
  if (!files.includes('index.js') || files.some(f => !/^[A-Za-z0-9._-]+\.(?:js|mjs)$/.test(f)) || new Set(files).size !== files.length) throw new Error('插件清单不可核对')
  const hash = createHash('sha256')
  for (const [name, bytes] of [['package.json', manifest], ...await Promise.all(files.sort().map(async name => [name, await readBounded(join(root, name), 1024 * 1024)]))]) {
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes)
  }
  return hash.digest('hex')
}
