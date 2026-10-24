import type Fuse from 'fuse-native'
import type { ListStore } from './store.ts'
import { createOps } from './fs.ts'

type FuseCtor = new (
  mnt: string,
  ops: ReturnType<typeof createOps>,
  opts?: Record<string, unknown>,
) => Fuse

/**
 * Mount the virtual filesystem exposing `<mnt>/tool` as a window onto the
 * harness's in-memory list. Resolves once the mount is active.
 *
 * The native addon is imported lazily so a missing libfuse or FUSE device
 * rejects this promise instead of crashing the process at module load.
 */
export async function mountSys(
  store: ListStore,
  mnt = './sys',
  extraOpts: Record<string, unknown> = {},
): Promise<Fuse> {
  const mod = (await import('fuse-native')) as unknown as { default: FuseCtor }
  const FuseCtor = mod.default

  const fuse = new FuseCtor(mnt, createOps(store), {
    mkdir: true,
    force: true,
    // Let the VFS enforce the mode bits we serve: the mount directory is
    // 0555 (read-only), so adding/removing entries fails at the kernel with
    // EACCES before reaching our handlers. The tool descriptor is owned by
    // the harness user and remains writable.
    defaultPermissions: true,
    ...extraOpts,
  })

  return new Promise((resolve, reject) => {
    fuse.mount((err) => (err ? reject(err) : resolve(fuse)))
  })
}

/** Unmount, ignoring unmount failures (e.g. FUSE unavailable in this container). */
export function unmountSys(fuse: Fuse | undefined): Promise<void> {
  if (!fuse) return Promise.resolve()
  return new Promise((resolve) => {
    fuse.unmount(() => resolve())
  })
}