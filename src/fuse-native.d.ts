declare module "fuse-native" {
  interface Stats {
    mode?: number;
    uid?: number;
    gid?: number;
    size?: number;
    nlink?: number;
    ino?: number;
    dev?: number;
    rdev?: number;
    blksize?: number;
    blocks?: number;
    atime?: Date | number;
    mtime?: Date | number;
    ctime?: Date | number;
  }

  /**
   * fuse-native passes the callback's first argument straight through as the
   * FUSE return value: `0`/`null` for success, a negative errno on failure —
   * except for read/write, where a positive byte count is the success value.
   */
  type ErrnoCallback = (err: number | null) => void;
  type StatsCallback = (err: number | null, stats?: Stats) => void;
  type NamesCallback = (err: number | null, names?: string[], stats?: Stats[]) => void;
  type FdCallback = (err: number | null, fd?: number) => void;
  type ByteCallback = (bytes: number) => void;

  export interface FuseOps {
    init?(cb: ErrnoCallback): void;
    getattr?(path: string, cb: StatsCallback): void;
    fgetattr?(path: string, fd: number, cb: StatsCallback): void;
    readdir?(path: string, cb: NamesCallback): void;
    open?(path: string, flags: number, cb: FdCallback): void;
    create?(path: string, mode: number, cb: FdCallback): void;
    read?(path: string, fd: number, buf: Buffer, len: number, pos: number, cb: ByteCallback): void;
    write?(path: string, fd: number, buf: Buffer, len: number, pos: number, cb: ByteCallback): void;
    release?(path: string, fd: number, cb: ErrnoCallback): void;
    truncate?(path: string, size: number, cb: ErrnoCallback): void;
    unlink?(path: string, cb: ErrnoCallback): void;
    mkdir?(path: string, mode: number, cb: ErrnoCallback): void;
    rmdir?(path: string, cb: ErrnoCallback): void;
    rename?(src: string, dest: string, cb: ErrnoCallback): void;
    chmod?(path: string, mode: number, cb: ErrnoCallback): void;
    chown?(path: string, uid: number, gid: number, cb: ErrnoCallback): void;
    access?(path: string, mode: number, cb: ErrnoCallback): void;
    flush?(path: string, fd: number, cb: ErrnoCallback): void;
    fsync?(path: string, datasync: number, fd: number, cb: ErrnoCallback): void;
    statfs?(path: string, cb: (err: number | null, statfs?: Record<string, number>) => void): void;
  }

  export interface FuseOptions {
    debug?: boolean;
    force?: boolean;
    mkdir?: boolean;
    allowOther?: boolean;
    allowRoot?: boolean;
    autoUnmount?: boolean;
    defaultPermissions?: boolean;
    kernelCache?: boolean;
    autoCache?: boolean;
    timeout?: number | false | Record<string, number | false>;
    [key: string]: unknown;
  }

  export default class Fuse {
    constructor(mnt: string, ops: FuseOps, opts?: FuseOptions);

    readonly mnt: string;
    mount(cb: (err?: Error | null) => void): void;
    unmount(cb: (err?: Error | null) => void): void;

    static unmount(mnt: string, cb: (err?: Error | null) => void): void;
    static isConfigured(cb: (err: Error | null, configured?: boolean) => void): void;

    static EPERM: number;
    static ENOENT: number;
    static EIO: number;
    static EISDIR: number;
    static ENOTDIR: number;
    static ENOSYS: number;
    static EROFS: number;
    static EINVAL: number;
    static EEXIST: number;
    static ENOTEMPTY: number;
    static EACCES: number;
    static EBADF: number;
    static ENAMETOOLONG: number;
    static ENODEV: number;
    static EBUSY: number;
    static EAGAIN: number;
    static ETIMEDOUT: number;
  }
}
