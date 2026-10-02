# Equall accessibility check

A GitHub Action that fails a pull request **only on the accessibility violations it introduces**. Existing debt is reported and never blocks, so you can turn the check on in a repository that is not clean yet.

It runs [equall-cli](https://github.com/GotaBird/equall), an open-source WCAG scanner for HTML, JSX/TSX, Vue, Svelte and Astro, directly on the runner. No account, no token. Your code never leaves the runner.

## Usage

```yaml
name: Accessibility
on: pull_request

jobs:
  equall:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: GotaBird/equall-action@v1
```

Each new finding is annotated on its file and line in the pull request.

## Inputs

| Input | Default | Description |
|---|---|---|
| `fail-on` | `critical` | Fail when the change introduces a violation at this severity or above: `critical`, `serious`, `moderate`, `minor`. Use `serious` for a stricter gate. |
| `path` | `.` | Path to scan, relative to the repository root. |
| `base` | the pull request target branch | Git ref to compare against. |
| `level` | `AA` | WCAG conformance target: `A`, `AA` or `AAA`. |
| `version` | `^0.3.4` | equall-cli version range to run. |
| `report-to` | empty | Equall ingest URL. With `project-key`, reports each check to Equall (see below). Empty: nothing leaves the runner. |
| `project-key` | empty | The project's key from its settings on Equall. Not a secret: pass it as a repository variable. |

## What blocks, and what does not

| Finding | Blocks the pull request? | Shown as |
|---|---|---|
| New violation at or above `fail-on` | yes | error annotation |
| New violation below `fail-on` | no | warning annotation |
| New finding static analysis cannot confirm, or best practice | no | notice annotation |
| Violation that already existed | no | one summary line |
| Changed file that cannot be statically tested (CSS, scripts…) | no | summary line |
| Changed file a scanner could not analyse (parse error) | no | warning annotation: its findings are unknown |

A passing check means no new violation was found statically. Contrast, focus order and other checks that need a rendered page still need their own test.

Outside a pull request (for example on `push`), the Action runs a report-only scan and never fails. Use the `pull_request` event: `pull_request_target` checks out the base branch, so there would be nothing to compare.

Every finding is also listed in the job summary: GitHub shows at most ten annotations of each kind per step.

## Report checks to Equall (optional)

By default nothing leaves the runner. Set `report-to` and `project-key` to also send each pull request check to your project on Equall, so the team can see what each pull request introduced and what was fixed before merge.

```yaml
name: Accessibility
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, closed]

concurrency:
  group: equall-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  id-token: write

jobs:
  equall:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: GotaBird/equall-action@v1
        with:
          report-to: https://rptqzdxiynbsesndqjwh.supabase.co/functions/v1/ingest-ci
          project-key: ${{ vars.EQUALL_PROJECT_KEY }}
```

- **URL**: this URL may change before 1.0; the project's settings on Equall show the current one.
- **Authentication**: `id-token: write` lets the Action request a short-lived GitHub identity token, which proves the report comes from this repository's own workflow. There is no secret to store. The token is never printed.
- **Project key**: copy it from the project's settings on Equall into a repository variable named `EQUALL_PROJECT_KEY`. It routes the report to that project; on its own, without this repository's identity token, it is useless.
- **Events**: `opened`, `synchronize` and `reopened` run the check and report it. `closed` reports that the pull request was merged or closed, without scanning: when you list `closed`, keep `reopened` too, so a reopened pull request is checked again. `edited` runs the check; it is reported only when the base branch changed.
- **What is sent**: the pull request's number, title, author, base branch and head commit; the equall-cli version, the `fail-on` threshold and the verdict; counts; and for each new finding its rule, WCAG criteria, severity, file, line and message. Never source code, HTML snippets or fix suggestions.
- **Never changes the verdict**: the job passes or fails on the check alone. If the report cannot be delivered, the log says why. A repository not yet connected to Equall gets a notice, not a failure. Temporary errors are retried twice.
- **Forks**: pull requests from forks get no identity token, so nothing is reported for them.
- **Trust model**: Equall records what your workflow reports and binds each report to this repository's identity token and project key. It does not re-run the scan.

## Exit codes

`0`: no new violation at the threshold. `1`: the change introduced one. `2`: the check could not run (for example, the base branch is missing). The log says why.

## License

MIT
