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
| `comment` | `false` | Comment on the pull request with the issues it introduces (see below). Needs `permissions: pull-requests: write`. |

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

## Comment on pull requests (optional)

With `comment: true`, the Action also comments on the pull request, and only about what the pull request introduces. A pull request that introduces nothing gets no comment.

```yaml
name: Accessibility
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: equall-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  id-token: write # only when you also report to Equall

jobs:
  equall:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - uses: GotaBird/equall-action@v1
        with:
          comment: true
```

**Check out the pull request head.** By default, `actions/checkout` checks out a merge of the pull request into its base branch. Its line numbers are not always the pull request's (the base branch may have changed the same file), so an inline comment could land on the wrong line. With `ref: ${{ github.event.pull_request.head.sha }}`, the scan runs on the commit the pull request shows, and its lines match the diff. The comparison still runs against the target branch, which the Action fetches. When the scanned commit is not the pull request head, the Action posts no inline comment: every new issue is listed in the summary, and the log says why.

- **Inline comments**: one per new violation (a counted WCAG violation within `level`), on its line, when that line is part of the pull request diff. Each says what is wrong, who it affects, and how to fix it. At most 10 per run; the rest are listed in the summary. A violation is commented once: re-running the check, or pushing again, does not repeat it.
- **Summary comment**: one comment, posted when the pull request introduces at least one new violation, then updated in place on every later run. It gives the count, lists the new violations that have no inline comment, and names the changed files static checks cannot test or could not analyse. Violations that already existed are counted in one line, never listed. Findings to review and best practices are counted in one line and listed in the job summary.
- **When the issues are gone**: the summary is updated to "No new accessibility issue found by static checks in this pull request", with what was fixed and the files that were not tested. It is never deleted. Inline comments whose issue is no longer found are marked as such (the original text stays, folded); GitHub's REST API cannot resolve review threads, so the threads stay open for you to resolve. An inline comment on a file that could not be analysed this time is left unchanged.
- **Which lines**: findings that have no line (axe-core reports none on HTML) or whose line is outside the diff are listed in the summary instead of inline. An inline comment GitHub marks as outdated (its line changed) no longer counts: the issue is commented again, or listed.
- **Events**: comments on `opened`, `synchronize`, `reopened` and `ready_for_review` only. Never on `closed`, `edited` or other events, and never outside a pull request.
- **Token**: the workflow's own `GITHUB_TOKEN`, with `pull-requests: write`. Nothing to store. Without that permission, the Action logs a warning and posts nothing.
- **Forks and Dependabot**: their pull requests get a read-only token, so the Action logs a notice and posts nothing. The results are in the job summary.
- **Several jobs**: each job keeps its own comments. They are scoped by workflow, job, `path` and `level`, so a monorepo with one job per `path`, or a matrix over `level`, gets one summary per job, and the summary header names the `path` when it is not `.`. Matrix jobs that differ in other values only share the same comments: give them different `path` or `level`, or comment from one of them.
- **Only its own comments**: comments are found again through hidden markers, and only when the GitHub Actions bot wrote them (or the token's own account, with a personal token). A marker copied by someone else is ignored. Text from the scanners is shown as code, so it can never mention someone, link or embed anything.
- **Never changes the verdict**: the comment step runs after the check, also when it fails, but not when the run is cancelled. A commenting error is only logged, and one failed comment does not stop the others.
- **Out-of-date runs**: if the pull request has a newer commit by the time the comment step runs, it writes nothing; the run on the newer commit comments.
- **Link to Equall**: when the check is also reported to Equall (`report-to`) and Equall answers with the pull request's page, the summary links to it. The link must be an `https://` URL on `equallscan.com` or `www.equallscan.com`; anything else is ignored.

### Machine-readable data

The summary comment carries the check's result for tools and agents, in a hidden HTML comment:

```html
<!-- equall:data {"schema":"equall.pr-check/v1", ...} -->
```

Schema `equall.pr-check/v1`:

| Field | Type | Description |
|---|---|---|
| `schema` | string | Always `equall.pr-check/v1`. A breaking change gets a new version. |
| `repository` | string | `owner/name`. |
| `pull_request` | number | Pull request number. |
| `head_sha` | string | Commit the check scanned (the pull request head when it is checked out). |
| `engine_version` | string \| null | equall-cli version that ran. |
| `counts.new` | number | New violations (counted WCAG violations within `level`). |
| `counts.fixed` | number | Violations the previous check listed that this one no longer finds (0 on the first check). A lower bound when the previous check's `truncated` was true; the comment then says "at least". |
| `counts.legacy` | number | Findings that already existed in the changed files. |
| `counts.review_only` | number | New findings static analysis cannot confirm. |
| `counts.not_testable` | number | Changed files outside the statically testable set. |
| `new_issues[]` | array | The new violations, at most 50 (`counts.new` has the full count). |
| `new_issues[].fingerprint` | string \| null | Stable identity of the issue across commits. |
| `new_issues[].file` | string | Path from the repository root. |
| `new_issues[].line` | number \| null | Line, when the scanner gives one. |
| `new_issues[].rule` | string | Scanner rule id. |
| `new_issues[].wcag` | string[] | WCAG success criteria. |
| `new_issues[].severity` | string \| null | `critical`, `serious`, `moderate` or `minor`. |
| `truncated` | boolean | `true` when `counts.new` is over 50 and `new_issues` lists only the first 50. |

It never contains source code, HTML snippets or messages.

## Exit codes

`0`: no new violation at the threshold. `1`: the change introduced one. `2`: the check could not run (for example, the base branch is missing). The log says why.

## License

MIT
