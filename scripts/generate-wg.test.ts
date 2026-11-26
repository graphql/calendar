import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getAgendaDetails } from 'wgutils'
import test from 'node:test'
import { calendarEvent, obsoleteEvents } from './generate-wg.ts'
import { generatedMarker } from './wg-event.ts'

test('renders a nested WG agenda with a prefilled host and a configured duration', async () => {
  const file = 'scripts/fixtures/working-group/agendas/meeting.md'
  const config = {
    repoSubpath: 'scripts/fixtures/working-group',
    name: 'Test WG',
    repoUrl: 'https://github.com/graphql/graphql-over-http',
    time: '10:00-11:00',
    timezone: 'UTC',
    frequency: 'monthly',
    weekday: 'Th',
    videoConferenceDetails: 'Test',
    attendeesTemplate: '| Name | GitHub | Organization | Location |\n| --- | --- | --- | --- |\n| Host | @host | | |',
  } satisfies Parameters<typeof getAgendaDetails>[0]
  const { meetings } = await getAgendaDetails(config, {})
  assert.equal(meetings.length, 1)
  const event = calendarEvent({
    repo: 'graphql-over-http',
    branch: 'main',
    contents: readFileSync(file, 'utf8'),
    config,
    meeting: meetings[0],
  })
  assert.equal(event.title, 'Be first: Fixture meeting')
  assert.equal(event.endUtc, '2099-01-02T11:00:00.000Z')
  assert.match(event.description, /^\*\*Be first\*\*: no attendees/)
  assert.equal(event.description.split('\n\n')[1], 'Zoom password: fixture123')
  assert.match(event.description, /updated roughly once every 12 hours\.$/)
  assert.equal(event.location, 'https://github.com/graphql/graphql-over-http/blob/main/' + file)
})

test('preserves an unparseable source and removes an event missing from the next import', () => {
  const source = 'graphql-over-http/working-group/agendas/meeting.md'
  const start = new Date(Date.now() + 86400000).toISOString()
  const file = `calendar/${start.slice(0, 4)}/${start.slice(5, 10)}-meeting.yaml`
  const contents = `${generatedMarker}${source}\nstartUtc: "${start}"\n`
  const existing = new Map([[file, contents]])
  assert.throws(() => obsoleteEvents(existing, new Map(), new Set([source])), /Previously imported agenda/)
  assert.deepEqual(obsoleteEvents(existing, new Map(), new Set()), [file])
  assert.deepEqual(obsoleteEvents(existing, existing, new Set()), [])
})
