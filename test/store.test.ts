import { describe, expect, it } from 'vitest'
import { ListStore } from '../src/store.ts'

describe('ListStore', () => {
  it('renders empty as empty string', () => {
    const s = new ListStore()
    expect(s.render()).toBe('')
    expect(s.size).toBe(0)
  })

  it('renders items one per line with trailing newline', () => {
    const s = new ListStore()
    s.append('alpha\nbeta\n')
    expect(s.render()).toBe('alpha\nbeta\n')
    expect(s.size).toBe(11)
  })

  it('append adds items to the end', () => {
    const s = new ListStore()
    s.append('one\ntwo\n')
    s.append('three\n')
    expect(s.items).toEqual(['one', 'two', 'three'])
  })

  it('append ignores NUL padding', () => {
    const s = new ListStore()
    s.append('one\0\0\0')
    expect(s.items).toEqual(['one'])
  })

  it('replace rewrites the whole list', () => {
    const s = new ListStore()
    s.append('one\ntwo\n')
    s.replace('solo\n')
    expect(s.items).toEqual(['solo'])
  })

  it('replace with empty text clears the list', () => {
    const s = new ListStore()
    s.append('one\n')
    s.replace('')
    expect(s.items).toEqual([])
    expect(s.render()).toBe('')
  })

  it('replace drops a trailing newline', () => {
    const s = new ListStore()
    s.replace('a\nb\n')
    expect(s.items).toEqual(['a', 'b'])
  })
})