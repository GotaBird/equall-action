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
      - uses: actions/checkout@v4
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
| `version` | `^0.3.2` | equall-cli version range to run. |

## What blocks, and what does not

| Finding | Blocks the pull request? | Shown as |
|---|---|---|
| New violation at or above `fail-on` | yes | error annotation |
| New violation below `fail-on` | no | warning annotation |
| New finding static analysis cannot confirm, or best practice | no | notice annotation |
| Violation that already existed | no | one summary line |
| Changed file that cannot be statically tested (CSS, scripts…) | no | summary line |

A passing check means no new violation was found statically. Contrast, focus order and other checks that need a rendered page still need their own test.

Outside a pull request (for example on `push`), the Action runs a report-only scan and never fails.

## Exit codes

`0`: no new violation at the threshold. `1`: the change introduced one. `2`: the check could not run (for example, the base branch is missing). The log says why.

## License

MIT
