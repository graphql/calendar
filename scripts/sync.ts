// Keeps a Google Calendar in sync with the YAML files in calendar/.
//
//   npm run validate  only validate all the files (no credentials needed)
//   BASE_SHA=<git-ref> npm run sync  sync the files added/changed/removed since <git-ref>
//
// Every file maps to exactly one event with a deterministic ID, so syncing is idempotent.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { google } from 'googleapis'
import { generatedMarker, localTime } from './wg-event.ts'
import yaml from 'js-yaml'

const repoRoot = resolve(import.meta.dirname, '..')
const calendarDir = join(repoRoot, 'calendar')
const OPTIONAL_FIELDS = ['endDay', 'hostedBy', 'startUtc', 'endUtc']
const FIELDS = ['startTime', 'endTime', 'timeZone', 'type', 'title', 'location', 'description', 'link'] as const
const TYPES = ['conference', 'working group', 'workshop', 'meetup', 'meeting']

type RequiredFields = Record<(typeof FIELDS)[number], string>
type CalendarEvent = RequiredFields & {
  path: string
  date: string
  slug: string
  endDay: string
  startUtc?: string
  endUtc?: string
  generated: boolean
  hostedBy?: string
}
type InvalidEvent = { path: string; errors: string[] }

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasRequiredFields(data: Record<string, unknown>, errors: string[]): data is RequiredFields & Record<string, unknown> {
  for (const k of FIELDS) {
    const value = data[k]
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`"${k}" is required and must be a non-empty string (quote times, e.g. "14:00")`)
    }
  }
  return errors.length === 0
}

function listEventFiles() {
  const files: string[] = []
  if (!existsSync(calendarDir)) return files
  for (const year of readdirSync(calendarDir, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue
    for (const f of readdirSync(join(calendarDir, year.name), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.yaml')) files.push(join(calendarDir, year.name, f.name))
      else if (f.isFile() && f.name.endsWith('.yml')) files.push(join(calendarDir, year.name, f.name))
    }
  }
  return files.sort()
}

// calendar/<YYYY>/<MM>-<DD>[-<slug>].yaml. Several events can share a day if their slugs differ.
const PATH_RE = /^calendar\/(\d{4})\/(\d{2})-(\d{2})(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?\.yaml$/

function isValidDate(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return false
  const [, y, mo, d] = m
  const dt = new Date(Date.UTC(+y, +mo - 1, +d))
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d
}

function parsePath(path: string) {
  const m = PATH_RE.exec(path)
  if (!m) return { error: 'path must look like calendar/<YYYY>/<MM>-<DD>.yaml or calendar/<YYYY>/<MM>-<DD>-<slug>.yaml (slug: lowercase letters, digits and dashes)' }
  const [, y, mo, d, slug = ''] = m
  if (!isValidDate(`${y}-${mo}-${d}`)) {
    return { error: `${y}-${mo}-${d} is not a valid date` }
  }
  return { date: `${y}-${mo}-${d}`, slug }
}

export function parseEvent(file: string, logicalPath?: string): CalendarEvent | InvalidEvent {
  const path = logicalPath ?? relative(repoRoot, file)
  try {
    return parseEventContents(readFileSync(file, 'utf8'), path)
  } catch (e) {
    return { path, errors: [String(e)] }
  }
}

export function parseEventContents(contents: string, path: string): CalendarEvent | InvalidEvent {
  const errors: string[] = []
  const { date, slug, error } = parsePath(path)
  if (error) errors.push(error)

  let generated: boolean
  let data: unknown
  try {
    generated = contents.startsWith(generatedMarker)
    data = yaml.load(contents)
  } catch (e) {
    return { path, errors: [...errors, `invalid YAML: ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (!isMapping(data)) {
    return { path, errors: [...errors, 'file must contain a YAML mapping'] }
  }

  for (const k of Object.keys(data)) {
    if (!FIELDS.some((field) => field === k) && !OPTIONAL_FIELDS.includes(k)) errors.push(`unknown property "${k}"`)
  }
  // An unquoted 2026-11-06 is parsed as a Date by YAML
  if (data.endDay instanceof Date) data.endDay = data.endDay.toISOString().slice(0, 10)
  if (!hasRequiredFields(data, errors) || date === undefined) return { path, errors }

  if (!TYPES.includes(data.type)) {
    errors.push(`"type" must be one of ${TYPES.map((t) => `"${t}"`).join(', ')}, got "${data.type}"`)
  }
  const hostedBy = typeof data.hostedBy === 'string' ? data.hostedBy : undefined
  if (data.hostedBy !== undefined && !hostedBy?.trim()) {
    errors.push('"hostedBy" must be a non-empty string when set')
  }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/
  for (const k of ['startTime', 'endTime'] as const) {
    if (!time.test(data[k])) errors.push(`"${k}" must be HH:MM in 24h format, got "${data[k]}"`)
  }
  let endDay = date
  if (data.endDay !== undefined) {
    if (typeof data.endDay !== 'string' || !isValidDate(data.endDay)) {
      errors.push(`"endDay" must be a valid YYYY-MM-DD date, got "${data.endDay}"`)
    } else if (data.endDay < date) {
      errors.push(`"endDay" (${data.endDay}) cannot be before the day of the event (${date})`)
    } else {
      endDay = data.endDay
    }
  }
  if (data.startUtc === undefined && endDay === date && time.test(data.startTime) && time.test(data.endTime) && data.endTime <= data.startTime) {
    errors.push('"endTime" must be after "startTime" (use "endDay" for events that end on a later day)')
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: data.timeZone })
    if (data.startUtc !== undefined || data.endUtc !== undefined) {
      for (const [value, day, time] of [
        [data.startUtc, date, data.startTime],
        [data.endUtc, endDay, data.endTime],
      ]) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toJSON() !== value) {
          errors.push('startUtc and endUtc must both be quoted UTC ISO timestamps')
          continue
        }
        const local = localTime(value, data.timeZone)
        if (local.date !== day || local.time !== time) errors.push('UTC timestamp differs from the local date or time')
      }
      if (String(data.endUtc) <= String(data.startUtc)) errors.push('endUtc must be later than startUtc')
    }
  } catch {
    errors.push(`"timeZone" must be an IANA time zone such as "Europe/Paris", got "${data.timeZone}"`)
  }
  try {
    const u = new URL(data.link)
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
  } catch {
    errors.push(`"link" must be an http(s) URL, got "${data.link}"`)
  }
  if (errors.length) return { path, errors }

  return { ...data, path, date, slug, endDay, hostedBy, generated }
}

// Google event IDs: 5-1024 chars of a-v and 0-9. A hex digest fits.
// The ID depends on the date and slug only.
const eventId = (date: string, slug: string) => 'gql' + createHash('sha1').update(`${date}/${slug}`).digest('hex')

function toGoogleEvent(e: CalendarEvent) {
  const header = [`type: ${e.type}`]
  if (e.hostedBy !== undefined) header.push(`hostedBy: ${e.hostedBy.trim()}`)
  return {
    id: eventId(e.date, e.slug),
    summary: e.title.trim(),
    location: e.location.trim(),
    description: e.generated ? e.description.trim() : `${header.join('\n')}\n\n${e.description.trim()}\n\n${e.link}`,
    source: { title: 'GraphQL Working Sessions', url: e.link },
    start: { dateTime: e.startUtc ?? `${e.date}T${e.startTime}:00`, timeZone: e.timeZone },
    end: { dateTime: e.endUtc ?? `${e.endDay}T${e.endTime}:00`, timeZone: e.timeZone },
  }
}

function getCalendar() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!calendarId || !key) {
    throw new Error('GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_KEY must be set')
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(key),
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  })
  return { calendarId, cal: google.calendar({ version: 'v3', auth }) }
}

function errCode(err: unknown): unknown {
  return err !== null && typeof err === 'object' && 'code' in err ? err.code : undefined
}

// Creates the event or, if its ID already exists (even as a cancelled event), updates it.
async function upsert({ cal, calendarId }: ReturnType<typeof getCalendar>, body: ReturnType<typeof toGoogleEvent>) {
  try {
    await cal.events.insert({ calendarId, requestBody: body })
    return 'created'
  } catch (err) {
    if (errCode(err) !== 409) throw err
    await cal.events.update({ calendarId, eventId: body.id, requestBody: { ...body, status: 'confirmed' } })
    return 'updated'
  }
}

async function remove({ cal, calendarId }: ReturnType<typeof getCalendar>, id: string) {
  try {
    await cal.events.delete({ calendarId, eventId: id })
    return true
  } catch (err) {
    const code = errCode(err)
    if (code === 404 || code === 410) return false // already gone
    throw err
  }
}

// Only touches the files that changed between `base` and HEAD.
async function syncIncremental(base: string) {
  const diff = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', base, 'HEAD', '--', 'calendar'], { cwd: repoRoot, encoding: 'utf8' })
  // -z output: STATUS \0 path \0 STATUS \0 path ...
  const parts = diff.split('\0').filter(Boolean)
  const changes = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (/^calendar\/\d{4}\/.*\.ya?ml$/.test(parts[i + 1])) changes.push({ status: parts[i], path: parts[i + 1] })
  }
  if (!changes.length) return console.log('No event file changed, nothing to sync')

  const toUpsert = changes.filter((c) => c.status !== 'D').map((c) => parseEvent(join(repoRoot, c.path)))
  failOnInvalid(toUpsert)

  const client = getCalendar()
  for (const c of changes.filter((c) => c.status === 'D')) {
    const { date, slug } = parsePath(c.path)
    if (!date) continue
    const gone = await remove(client, eventId(date, slug))
    console.log(`${c.path}: ${gone ? 'deleted' : 'was not in the calendar'}`)
  }
  for (const e of toUpsert) console.log(`${e.path}: ${await upsert(client, toGoogleEvent(e))}`)
}

function failOnInvalid(events: (CalendarEvent | InvalidEvent)[]): asserts events is CalendarEvent[] {
  const invalid = events.filter((e) => 'errors' in e)
  for (const e of invalid) {
    for (const msg of e.errors) console.error(`::error file=${e.path}::${msg}`)
  }
  if (invalid.length) {
    console.error(`${invalid.length} invalid event file(s)`)
    process.exit(1)
  }
}

if (import.meta.main) {
  if (process.argv.includes('--validate')) {
    const events = listEventFiles().map((file) => parseEvent(file))
    failOnInvalid(events)
    console.log(`${events.length} event file(s) valid`)
  } else if (process.env.BASE_SHA) {
    await syncIncremental(process.env.BASE_SHA)
  } else {
    console.error('usage: npm run validate, or BASE_SHA=<git-ref> npm run sync')
    process.exit(2)
  }
}
