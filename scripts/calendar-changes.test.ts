import assert from 'node:assert/strict'
import { memfs } from 'memfs'
import test from 'node:test'
import { applyChanges } from './calendar-changes.ts'

test('applies YAML edits and deletions only within the calendar tree', () => {
  const { fs } = memfs({})
  const path = 'calendar/2027/01-02-Meeting_Notes.yaml'
  const apply = (path: string, contents: string | null) => applyChanges(JSON.stringify([{ path, contents }]), fs)
  apply(path, 'title: Original')
  apply(path, 'title: Updated')
  assert.equal(fs.readFileSync(path, 'utf8'), 'title: Updated')
  const shortPath = 'calendar/2027/01-02-meeting.yml'
  apply(shortPath, 'title: Meeting')
  assert.equal(fs.readFileSync(shortPath, 'utf8'), 'title: Meeting')
  apply(shortPath, null)
  assert.equal(fs.existsSync(shortPath), false)
  fs.mkdirSync('outside')
  fs.symlinkSync('../outside', 'calendar/2028')
  for (const invalid of ['README.md', 'calendar/../outside/a.yaml', 'calendar/2028/01-02-a.yaml', 'calendar/a.ts']) {
    assert.throws(() => apply(invalid, '{}'))
  }
  assert.throws(() => apply(path, '[invalid'))
  assert.equal(fs.readFileSync(path, 'utf8'), 'title: Updated')
  apply(path, null)
  assert.equal(fs.existsSync(path), false)
})

test('rejects invalid path components and suffixes for writes and deletions', () => {
  const { fs } = memfs({})
  for (const path of [
    'calendar/meeting.yaml',
    'calendar/27/01-02-a.yaml',
    'calendar/2027/nested/01-02-a.yaml',
    'calendar/2027/1-02-a.yaml',
    'calendar/2027/01-2-a.yaml',
    'calendar/2027/01-02.yaml',
    'calendar/2027/01-02-.yaml',
    'calendar/2027/01-02-.hidden.yaml',
    'calendar/2027/01-02-a.b.yaml',
    'calendar/2027/01-02-a.YML',
    'calendar/2027/01-02-a b.yaml',
    'calendar/2027/01-02-a.yaml\n',
    'calendar/2027/01-02-é.yaml',
  ]) {
    for (const contents of ['{}', null]) {
      assert.throws(() => applyChanges(JSON.stringify([{ path, contents }]), fs), /Invalid calendar path/, path)
    }
  }
})
