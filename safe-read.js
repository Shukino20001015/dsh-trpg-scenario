import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

// Windows does not implement O_NOFOLLOW. Check the path before and after
// opening and compare it with the handle to reject ordinary links and many
// replacements. This is not an atomic no-follow guarantee against an attacker
// concurrently replacing paths or parent directories on every platform.
export async function openRegularRead(path) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('文件类型不安全')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const handle = await file.stat({ bigint: true })
    const after = await lstat(path, { bigint: true })
    if (!handle.isFile() || !after.isFile() || after.isSymbolicLink() ||
        before.dev !== handle.dev || before.ino !== handle.ino ||
        after.dev !== handle.dev || after.ino !== handle.ino) throw new Error('文件在读取前发生变化')
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}
