import { constants } from 'node:fs'
import type { FuseOps } from 'fuse-native'
import type { ListStore } from './store.ts'

const DIR_MODE = 0o40755 // S_IFDIR | 0755
const FILE_MODE = 0o100644 // S_IFREG | 0644

const TOOL_PATH = '/tool'

// POSIX errnos as negative values, matching fuse-native's constants — kept
// local so this module has no load-time dependency on the native addon.
const EPERM = -1
const ENOENT = -2
const EBADF = -9
const EEXIST = -17
const ENOTDIR = -20

interface OpenHandle {
  mode: 'append' | 'replace' | 'read'
  truncPending: boolean
  chunks: Buffer[]
}

/**
 * Build the FUSE operation set for a mount whose single file (`/tool`) is a
 * window onto the harness's in-memory list.
 *
 * Semantics:
 *  - read  -> the list, one item per line
 *  - open for append (`>>`, O_APPEND) -> written lines are added on close
 *  - open for write (`>`, O_TRUNC)    -> written content replaces the list on close
 *  - unlink                             -> always fails (EPERM)
 */
export function createOps(store: ListStore): FuseOps {
  const openFiles = new Map<number, OpenHandle>()
  let nextFd = 1000
  // The kernel delivers O_TRUNC as a standalone SETATTR(0) after OPEN rather
  // than (only) in the open flags; record it and consume it at release.
  let pendingTruncate = false

  return {
    getattr(path, cb) {
      if (path === '/') {
        cb(null, { mode: DIR_MODE, size: 4096, nlink: 2, uid: 0, gid: 0 })
        return
      }
      if (path === TOOL_PATH) {
        cb(null, {
          mode: FILE_MODE,
          size: store.size,
          nlink: 1,
          uid: 0,
          gid: 0,
        })
        return
      }
      cb(ENOENT)
    },

    readdir(path, cb) {
      if (path === '/') {
        cb(null, ['tool'])
        return
      }
      cb(ENOTDIR)
    },

    open(path, flags, cb) {
      if (path !== TOOL_PATH) {
        cb(ENOENT, 0)
        return
      }
      const acc = flags & 3 // O_ACCMODE: 0 = read, 1 = write, 2 = rdwr
      const isAppend = (flags & constants.O_APPEND) !== 0
      const mode = acc === 0 ? 'read' : isAppend ? 'append' : 'replace'
      const fd = nextFd++
      openFiles.set(fd, {
        mode,
        truncPending: (flags & constants.O_TRUNC) !== 0,
        chunks: [],
      })
      // fuse-native's open signal reads the errno as int32 — must be a number.
      cb(0, fd)
    },

    create(path, _mode, cb) {
      // The only file is `tool`, and it always exists — creating anything else fails.
      if (path !== TOOL_PATH) {
        cb(EEXIST, 0)
        return
      }
      const fd = nextFd++
      openFiles.set(fd, { mode: 'replace', truncPending: true, chunks: [] })
      // Same as open: the errno argument must be a number, not null.
      cb(0, fd)
    },

    read(_path, _fd, buf, len, pos, cb) {
      const data = Buffer.from(store.render(), 'utf8')
      if (pos >= data.length) {
        cb(0)
        return
      }
      const part = data.subarray(pos, pos + len)
      part.copy(buf, 0)
      cb(part.length)
    },

    write(_path, fd, buf, len, pos, cb) {
      const handle = openFiles.get(fd)
      if (!handle) {
        cb(EBADF)
        return
      }
      handle.chunks.push(Buffer.from(buf.subarray(0, len)))
      // `pos` is ignored: kernel writes arrive in order and the commit happens
      // at close, where append vs. replace decides how they are applied.
      void pos
      cb(len)
    },

    release(_path, fd, cb) {
      const handle = openFiles.get(fd)
      if (handle) {
        openFiles.delete(fd)
        const text = Buffer.concat(handle.chunks).toString('utf8')
        if (handle.mode === 'append') {
          // splitItems of '' yields no items, so an append open with no
          // writes is a no-op.
          store.append(text)
        } else if (handle.mode === 'replace') {
          // Commit a rewrite only when something was actually written or the
          // open was destructive (O_TRUNC flag or a trailing SETATTR(0)).
          // Read-only handles never reach here.
          const destructive = handle.truncPending || pendingTruncate
          pendingTruncate = false
          if (handle.chunks.length > 0 || destructive) store.replace(text)
        }
        // mode === 'read': never commits.
      }
      cb(0)
    },

    truncate(path, size, cb) {
      if (path === TOOL_PATH && size === 0) {
        if (openFiles.size > 0) {
          // Truncate that belongs to an open handle (O_TRUNC semantics):
          // defer to release so the subsequent writes land first.
          pendingTruncate = true
        } else {
          // Standalone truncate-to-zero clears the list immediately.
          store.replace('')
        }
      }
      cb(0)
    },

    unlink(path, cb) {
      if (path !== TOOL_PATH) {
        cb(ENOENT)
        return
      }
      // The list is never deletable — deletion always fails.
      cb(EPERM)
    },
  }
}