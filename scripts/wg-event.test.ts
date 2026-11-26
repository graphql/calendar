import assert from 'node:assert/strict'
import test from 'node:test'
import { agendaOverview, zoomPassword, localTime, tentative } from './wg-event.ts'

test('agenda overview includes top-level discussion items only', () => {
  const items = [
    { title: 'Housekeeping', duration: '15m', owner: 'Host', subitems: [{ title: 'detail' }] },
    { title: 'Proposal', duration: '5m', owner: 'Contributor', subitems: [{ title: 'background' }] },
    { title: 'Discussion', duration: null, owner: null },
  ]
  assert.deepEqual(agendaOverview(items), ['Proposal', 'Discussion'])
})
test('extracts a password from the agenda when present', () => {
  assert.equal(zoomPassword('  - _Password:_ example'), 'example')
  assert.equal(zoomPassword('No password supplied.'), undefined)
})
test('tentative notices identify each missing contribution', () => {
  assert.equal(tentative(true, true), '')
  assert.match(tentative(true, false), /no attendees/)
  assert.match(tentative(false, true), /no agenda items yet/)
  assert.match(tentative(false, false), /agenda items or attendees/)
})
test('local times across midnight and the autumn fold', () => {
  assert.deepEqual(localTime('2027-01-01T01:00:00Z', 'US/Pacific'), { date: '2026-12-31', time: '17:00' })
  assert.deepEqual(localTime('2026-11-01T08:30:00Z', 'US/Pacific'), localTime('2026-11-01T09:30:00Z', 'US/Pacific'))
})
