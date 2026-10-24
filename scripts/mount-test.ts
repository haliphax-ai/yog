// Live FUSE mount test with per-op logging.
import { readFile, writeFile, appendFile, rm, readdir, stat, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { mountSys, unmountSys } from '../src/mount.ts'
import { ListDescriptor } from '../src/fs/list.ts'
import { DescriptorRegistry } from '../src/fs/index.ts'

const mnt = './sys-test'
const file = `${mnt}/list`
const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`)

const list = new ListDescriptor()
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) log(`ok   ${name}`)
  else {
    failed++
    log(`FAIL ${name} ${detail}`)
  }
}

try {
  log('mounting...')
  const descriptors = new DescriptorRegistry([['/list', list]])
  const fuse = await mountSys(descriptors.buildOps(), mnt, {
    // set FUSE_DEBUG=1 to see raw FUSE opcodes on stderr
    debug: process.env['FUSE_DEBUG'] === '1',
  })
  log(`mounted at ${fuse.mnt}`)

  log('readdir...')
  const entries = await readdir(mnt)
  check('readdir shows only list', entries.length === 1 && entries[0] === 'list', JSON.stringify(entries))

  log('stat...')
  const st = await stat(file)
  check('stat of list', st.isFile() && st.size === 0, JSON.stringify({ size: st.size }))

  log('read empty...')
  const empty = await readFile(file, 'utf8')
  check('read of empty list', empty === '', JSON.stringify(empty))

  log('append...')
  await appendFile(file, 'alpha\nbeta\n')
  let text = await readFile(file, 'utf8')
  check('append + read', text === 'alpha\nbeta\n', JSON.stringify(text))

  log('append2...')
  await appendFile(file, 'gamma\n')
  text = await readFile(file, 'utf8')
  check('second append', text === 'alpha\nbeta\ngamma\n', JSON.stringify(text))
  check('store reflects appends', list.items.length === 3, JSON.stringify(list.items))

  log('rewrite...')
  await writeFile(file, 'solo\n')
  text = await readFile(file, 'utf8')
  check('destructive rewrite', text === 'solo\n', JSON.stringify(text))
  check('store reflects rewrite', list.items.length === 1, JSON.stringify(list.items))

  log('delete attempt...')
  let deleteErr: unknown = null
  try {
    await rm(file)
  } catch (err) {
    deleteErr = err
  }
  check(
    'delete fails',
    deleteErr !== null,
    deleteErr
      ? String((deleteErr as { code?: string; message?: string }).code ?? (deleteErr as Error).message)
      : 'succeeded!',
  )
  const stillThere = await readdir(mnt)
  check('list survives failed delete', stillThere.includes('list'), JSON.stringify(stillThere))

  // The mount directory is 0555 + default_permissions: creating any new entry
  // must fail at the VFS with EACCES before reaching our handlers.
  log('create sibling ...')
  {
    let createErr: unknown = null
    try {
      await writeFile(`${mnt}/nope`, 'x')
    } catch (err) {
      createErr = err
    }
    check(
      'cannot create new file in mount',
      createErr !== null,
      createErr ? String((createErr as { code?: string }).code ?? (createErr as Error).message) : 'succeeded!',
    )
    const afterCreate = await readdir(mnt)
    check('no new entries after denied create', afterCreate.length === 1, JSON.stringify(afterCreate))
  }

  // --- read battery: offsets, EOF edges, multi-chunk reads ---
  const bigLines: string[] = []
  for (let i = 1; i <= 1000; i++) bigLines.push(`line-${String(i).padStart(4, '0')}`)
  const bigExpected = bigLines.join('\n') + '\n'
  log(`write big list (${bigExpected.length} bytes)...`)
  await writeFile(file, bigExpected)
  check('big list size matches stat', (await stat(file)).size === bigExpected.length)

  log('read big list (multi-chunk)...')
  const bigRead = await readFile(file, 'utf8')
  check(
    'multi-chunk read matches exactly',
    bigRead.length === bigExpected.length && bigRead === bigExpected,
    `got ${bigRead.length} bytes, want ${bigExpected.length}`,
  )

  log('offset read via FileHandle...')
  {
    const fh = await open(file, 'r')
    const buf = Buffer.alloc(10)
    const { bytesRead } = await fh.read(buf, 0, 10, 100)
    check('offset read: 10 bytes at pos 100', bytesRead === 10, `bytesRead=${bytesRead}`)
    check(
      'offset read: content matches slice',
      buf.toString('utf8') === bigExpected.slice(100, 110),
      JSON.stringify(buf.toString('utf8')),
    )

    // partial read crossing EOF
    const pbuf = Buffer.alloc(64)
    const size = bigExpected.length
    const partial = await fh.read(pbuf, 0, 64, size - 10)
    check('read crossing EOF returns remainder', partial.bytesRead === 10, `bytesRead=${partial.bytesRead}`)
    check(
      'read crossing EOF content',
      pbuf.subarray(0, partial.bytesRead).toString('utf8') === bigExpected.slice(size - 10),
    )

    // read exactly at EOF → 0 bytes
    const eofBuf = Buffer.alloc(8)
    const atEof = await fh.read(eofBuf, 0, 8, size)
    check('read at EOF returns 0 bytes', atEof.bytesRead === 0, `bytesRead=${atEof.bytesRead}`)

    // read past EOF → 0 bytes
    const pastBuf = Buffer.alloc(8)
    const pastEof = await fh.read(pastBuf, 0, 8, size + 500)
    check('read past EOF returns 0 bytes', pastEof.bytesRead === 0, `bytesRead=${pastEof.bytesRead}`)
    await fh.close()
  }

  log('createReadStream with start/end (partial stream)...')
  {
    const chunks: Buffer[] = []
    const rs = createReadStream(file, { start: 10, end: 29 })
    await new Promise<void>((resolve, reject) => {
      rs.on('data', (c: Buffer) => chunks.push(c))
      rs.on('end', resolve)
      rs.on('error', reject)
    })
    const streamed = Buffer.concat(chunks).toString('utf8')
    check(
      'stream range 10..29 matches slice',
      streamed === bigExpected.slice(10, 30),
      JSON.stringify(streamed),
    )
  }

  log('reads do not mutate the store...')
  check('store intact after read battery', list.items.length === 1000, `items=${list.items.length}`)

  // restore: leave a small list, then final full read round-trip
  await writeFile(file, 'alpha\n')
  check('final full read after truncate', (await readFile(file, 'utf8')) === 'alpha\n')

  log('unmounting...')
  await unmountSys(fuse)
  log('unmounted — DONE')
} catch (err) {
  failed++
  log(`FAIL unexpected error: ${(err as Error)?.stack ?? err}`)
}

process.exit(failed > 0 ? 1 : 0)