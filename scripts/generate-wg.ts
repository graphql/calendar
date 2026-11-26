import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import yaml from 'js-yaml'
import { getAgendaDate, type getAgendaDetails, looksLikeItMightHaveBeenCancelled } from 'wgutils'
import { parseEventContents } from './sync.ts'
import { agendaOverview, generatedMarker, localTime, tentative, zoomPassword } from './wg-event.ts'

type Config = Parameters<typeof getAgendaDetails>[0]
type Meeting = Awaited<ReturnType<typeof getAgendaDetails>>['meetings'][number]
const root = resolve(import.meta.dirname, '..')
const repos = [
  'graphql-wg',
  'graphql-js-wg',
  'graphql-over-http',
  'graphiql',
  'ai-wg',
  'community-wg',
  'composite-schemas-wg',
  'defer-stream-wg',
  'golden-path-wg',
  'nullability-wg',
  'otel-wg',
]
const introductions: Record<string, string> = {
  graphiql: 'The GraphiQL Working Group discusses GraphiQL, the GraphQL language server, and IDE tooling.',
  'ai-wg': 'The GraphQL AI Working Group explores how GraphQL can support artificial intelligence and machine learning.',
  'community-wg': 'The GraphQL Community Working Group develops initiatives to explain GraphQL and support its global community.',
  'golden-path-wg': 'The Golden Path Working Group documents practices that help new GraphQL users succeed and promotes their adoption across GraphQL tools.',
  'otel-wg': 'The OpenTelemetry Working Group develops best practices and semantic conventions for using OpenTelemetry with GraphQL.',
  'defer-stream-wg': 'The Incremental Delivery Working Group designs support for incremental delivery in the GraphQL specification.',
}
const now = new Date()
const until = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 1)
const inWindow = (date: Date) => +date >= +now && +date < until
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const read = (path: string) => readFileSync(path, 'utf8')

function refresh(repo: string) {
  const dir = join(root, 'repos', repo)
  const url = `https://github.com/graphql/${repo}.git`
  if (!existsSync(dir)) git(root, 'clone', '--depth=1', url, dir)
  if (git(dir, 'config', '--get', 'remote.origin.url') !== url || git(dir, 'status', '--porcelain')) throw Error(`Unexpected remote or dirty checkout: ${dir}`)
  git(dir, 'fetch', '--depth=1', 'origin', 'HEAD')
  git(dir, 'checkout', '--detach', 'FETCH_HEAD')
  return dir
}

function fallbackEnd(start: string, range: string) {
  const m = /^(\d\d?):(\d\d)-(\d\d?):(\d\d)$/.exec(range)
  if (!m) throw Error('Missing agenda end and invalid configured duration')
  const minutes = ((+m[3] - +m[1]) * 60 + +m[4] - +m[2] + 1440) % 1440
  return new Date(Date.parse(start) + minutes * 60000).toISOString()
}

export function calendarEvent({
  repo,
  branch,
  contents,
  config,
  meeting,
  secondary,
}: {
  repo: string
  branch: string
  contents: string
  config: Pick<Config, 'time' | 'timezone' | 'description' | 'name'>
  meeting: Meeting
  secondary?: { time: string; description?: string }
}) {
  const start = localTime(meeting.start, config.timezone)
  const topics = agendaOverview(meeting.topics)
  const notice = tentative(!!topics.length, meeting.hasSignups)
  const endUtc = meeting.end ?? fallbackEnd(meeting.start, secondary?.time ?? config.time)
  const end = localTime(endUtc, config.timezone)
  const intro =
    introductions[repo] ??
    (secondary?.description ?? config.description ?? config.name)
      .trim()
      .split(/\n\s*\n/)[0]
      .replace(/\n/g, ' ')
      .replace(/\[([^\]]+)\](?:\[.*?\]|\([^)]*\))/g, '$1')
  const link = `https://github.com/graphql/${repo}/blob/${branch}/${meeting.path.split('/').map(encodeURIComponent).join('/')}`
  const password = zoomPassword(contents)
  return {
    startTime: start.time,
    endTime: end.time,
    timeZone: config.timezone,
    startUtc: meeting.start,
    endUtc,
    ...(start.date === end.date ? {} : { endDay: end.date }),
    type: 'working group',
    title: (notice ? 'Be first: ' : '') + meeting.title,
    location: link,
    description: [
      notice,
      password && `Zoom password: ${password}`,
      intro,
      'How to join: https://graphql.org/community/contribute/project-meetings/',
      topics.length ? 'Agenda topics:\n' + topics.map((t) => '- ' + t).join('\n') : 'Agenda is open, submit your discussion topics',
      link,
      'This description is updated roughly once every 12 hours.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    link,
  }
}

async function collect(repo: string, desired: Map<string, string>, unparseableSources: Set<string>) {
  const dir = refresh(repo)
  const config: Config = (await import(join(dir, 'wg.config.js'))).default
  const folder = join(config.repoSubpath ?? '', config.agendasFolder ?? 'agendas')
  if (!existsSync(join(dir, folder))) throw Error(`Missing agenda directory in ${repo}`)
  const files = globSync('**/*.md', { cwd: join(dir, folder) }).map((f) => join(folder, f).split(sep).join('/'))
  const candidates = files.filter((file) => {
    const contents = read(join(dir, file))
    if (looksLikeItMightHaveBeenCancelled(contents)) return false
    const date = getAgendaDate(contents)
    if (!date) unparseableSources.add(`${repo}/${file}`)
    return date && inWindow(date)
  })
  if (!candidates.length) return
  const months = new Set(
    candidates.map((f) =>
      f
        .match(/\/(\d{4})\/(\d{2})-/)
        ?.slice(1)
        .join('-'),
    ),
  )
  const meetings = new Map<string, Meeting>()
  for (const month of months) {
    const filter = month?.split('-') ?? []
    const json = execFileSync(join(root, 'node_modules/.bin/wgutils'), ['agenda', 'details', ...filter, '--json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    for (const meeting of JSON.parse(json).meetings as Meeting[]) meetings.set(meeting.path, meeting)
  }
  const branch = git(dir, 'ls-remote', '--symref', 'origin', 'HEAD').match(/ref: refs\/heads\/(.+)\s+HEAD/)?.[1]
  if (!branch) throw Error(`Missing default branch for ${repo}`)
  for (const file of candidates) {
    try {
      const contents = read(join(dir, file))
      const meeting = meetings.get(file)
      if (!meeting) throw Error('wgutils omitted upcoming agenda')
      const start = localTime(meeting.start, config.timezone)
      const year = start.date.slice(0, 4)
      const secondary = config.secondaryMeetings?.find((s) => s.filenameFragment && basename(file).slice(3) === s.filenameFragment + '.md')
      const event = calendarEvent({ repo, branch, contents, config, meeting, secondary })
      const path = `calendar/${year}/${start.date.slice(5)}-${repo}-${createHash('sha256').update(file).digest('hex').slice(0, 10)}.yaml`
      const body = generatedMarker + repo + '/' + file + '\n' + yaml.dump(event, { lineWidth: -1, quotingType: '"' })
      const parsed = parseEventContents(body, path)
      if ('errors' in parsed) throw Error(parsed.errors.join(', '))
      desired.set(path, body)
    } catch (cause) {
      throw Error(`Cannot import ${repo}/${file}`, { cause })
    }
  }
}

export function obsoleteEvents(existing: Map<string, string>, desired: Map<string, string>, unparseableSources: Set<string>) {
  const remove: string[] = []
  for (const [file, contents] of existing) {
    if (desired.has(file) && contents.split('\n')[0] !== desired.get(file)!.split('\n')[0]) throw Error(`Event path collision: ${file}`)
    if (!contents.startsWith(generatedMarker) || desired.has(file)) continue
    const source = contents.split('\n')[0].slice(generatedMarker.length)
    if (!repos.includes(source.split('/')[0]) || !inWindow(new Date((yaml.load(contents) as { startUtc: string }).startUtc))) continue
    if (unparseableSources.has(source)) throw Error(`Previously imported agenda has no recognized start: ${source}`)
    remove.push(file)
  }
  return remove
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.chdir(root)
  mkdirSync(join(root, 'repos'), { recursive: true })
  const desired = new Map<string, string>()
  const unparseableSources = new Set<string>()
  for (const repo of repos) await collect(repo, desired, unparseableSources)
  const existing = new Map(globSync('calendar/*/*.yaml').map((file) => [file, read(file)]))
  const remove = obsoleteEvents(existing, desired, unparseableSources)
  for (const [file, body] of desired) {
    mkdirSync(dirname(file), { recursive: true })
    if (existing.get(file) !== body) writeFileSync(file, body)
  }
  for (const file of remove) rmSync(file)
  console.log(`${desired.size} upcoming WG events, ${remove.length} removed`)
}
