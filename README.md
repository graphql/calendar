# GraphQL calendar automation

The `calendar/` directory holds data to modify the calendar at https://calendar.graphql.org

Every event of the working sessions calendar lives in `calendar/` as a small YAML file.

When a change to `calendar/` is merged to `main`, a GitHub Action updates the shared Google Calendar automatically. Never edit those events by hand in Google calendar: manual changes to synced events are overwritten on the next sync. It's OK to create other events manually in Google calendar but those events won't be handled by this repository.

The data in the GraphQL calendar in turn is used to hydrate https://graphql.org/community/events/ so it's always best to add your event in the calendar as a source of truth.

## One file per event

```
calendar/<year>/<month>-<day>-<slug>.yaml
```

For example `calendar/2026/11-04-working-session.yaml` is an event on 4 November 2026. Month and day are always two digits. The date of the event comes from the file name.

The optional slug (lowercase letters, digits and dashes) lets you have **several events on the same day**: `11-04-working-session.yaml` and `11-04-social.yaml` are two separate events. A day can have at most one event without a slug (`11-04.yaml`), and each slug can be used once per day.

The slug is not shown in the calendar, but it identifies the event: **renaming a file to change its slug removes the old calendar event and creates a new one**.

## File format

```yaml
startTime: "16:00"
endTime: "17:00"
timeZone: Europe/Paris
type: meetup
# hostedBy: FOST PARIS   # optional, for non-foundation events.
title: GraphQL Working Session
location: https://zoom.us/j/0000000000
description: Agenda and notes for this session.
link: https://github.com/graphql/working-sessions
# endDay: 2026-11-06   # optional, for events spanning several days
```

| Property      | Description                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTime`   | Start time, 24h `HH:MM`, in `timeZone`. **Put it in quotes.**                                                                                                                |
| `endTime`     | End time, 24h `HH:MM`, in `timeZone`, on the last day of the event. Must be after `startTime` unless `endDay` is set.                                                        |
| `timeZone`    | [IANA time zone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `America/New_York`, `Europe/Paris`, `UTC`.                                         |
| `endDay`      | _Optional._ Last day of a multi-day event, as `YYYY-MM-DD`. Defaults to the day in the file name. The event runs from `startTime` on the first day to `endTime` on `endDay`. |
| `type`        | One of `conference`, `working group`, `workshop`, `meetup`, `meeting`.                                                                                                       |
| `hostedBy`    | _Optional._ Free text: who hosts the event.                                                                                                                                  |
| `title`       | Event title.                                                                                                                                                                 |
| `location`    | Free text: a video call URL, an address, etc.                                                                                                                                |
| `description` | Free text description.                                                                                                                                                       |
| `link`        | `http(s)` URL with more information (agenda, notes, ...). It is also appended to the calendar event description.                                                             |

For hand-authored events, the calendar description starts with the type and, if set, the host:

```
type: conference
hostedBy: FOST Paris

<description>

<link>
```

All properties are required except `endDay` and `hostedBy`, and no other property is allowed.

## Adding an event

1. Create `calendar/<year>/<month>-<day>[-<slug>].yaml` with the properties above.
2. Open a pull request. A check validates your file and reports errors on the offending files.
3. Once the PR is merged, the event shows up in the Google Calendar within a minute or so.

## Editing an event

Edit the file and open a pull request. The existing calendar event is updated in place.

To **move an event to another day** (or change its slug), rename the file. The old event is removed and a new one is created.

## Removing an event

Delete the file in a pull request. The event is removed from the Google Calendar on merge.

## Validation

You can check your changes locally (Node 24):

```sh
npm ci
npm run format:check
npm run typecheck
npm run validate
```

## Maintainers: setup

The sync workflow (`.github/workflows/calendar-sync.yml`) needs two repository secrets:

- `GOOGLE_SERVICE_ACCOUNT_KEY`: the JSON key of a Google Cloud service account (with the Google Calendar API enabled).
- `GOOGLE_CALENDAR_ID`: the ID of the target calendar (Calendar settings → "Integrate calendar").

Share the target calendar with the service account's email address with the **"Make changes to events"** permission.

The workflow is incremental: on each push to `main` it only creates, updates or deletes the events of the files that changed in that push. Events not backed by a file in `calendar/` are never touched.

## How it works

The sync is driven by `git diff`. On each push to `main`, `scripts/sync.ts` diffs `calendar/` between the previous tip of `main` and the new one, and only acts on the files that changed:

- **added or modified** files: the matching calendar event is created, or updated if it already exists.
- **deleted** files: the matching calendar event is removed.
- a **renamed** file counts as a deletion plus an addition.

Each event gets a stable Google Calendar ID derived from its date and slug (a hash of `<date>/<slug>`), so the script always knows which calendar event belongs to which file without keeping any state.

This has two benefits:

- **No full rebuild.** The calendar is never wiped and recreated from scratch: a push that touches one file makes one or two API calls, whatever the number of events in the repository.
- **Events created outside this repository keep working.** The script only ever touches the event IDs it computes from files in `calendar/`. Events added directly in Google Calendar have other IDs, so they are never modified or deleted by the sync.

## Working group agendas

Run `npm ci` and `npm run generate:wg` at the repository root with Node 24. The generator clones and refreshes the eleven working group repositories under the gitignored `repos/` directory. It uses the calendar repository's installation of wgutils and each checkout's configuration, including nested agenda directories. Review the changes with `git status` and run `npm run validate`. Local generation requires no Google credentials.

Generated WG descriptions are synced verbatim. They open with the “Be first” notice when applicable, followed by the Zoom password if the agenda provides one.

The importer covers upcoming meetings through the end of the third following UTC month. It marks files with their source path and removes future generated events when their agenda disappears or wgutils recognizes a cancellation. The paired optional fields `startUtc` and `endUtc` preserve exact instants alongside WG-local dates and times.

The agenda refresh workflow runs at 00:17 and 12:17 UTC and supports manual dispatch on main. Generation runs with read-only repository access. It passes YAML edits and deletions under `calendar/` to a fresh publishing runner through a JSON job output. The publisher validates the entries and pushes changes to main. A separate job syncs that exact commit against its parent. If Google Calendar returns an error, use “Re-run failed jobs” to retry the published diff. The job needs permission to push to main.
