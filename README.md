# skill-sync

Syncs a skill package folder from a source repo (e.g. a monorepo like `kairos`)
into its dedicated published repo (e.g. `kairos-skill`), then opens a pull
request there with the diff. Nothing ever lands on the published repo's
default branch without a human merging the PR.

Ships as a container, so it works the same way in any CI/CD system that can
run a Docker image — GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite,
or your own machine. There's nothing GitHub-Actions-specific about *running*
it; the only GitHub-specific part is that the destination repo it opens a PR
against is a GitHub repo (via the `gh` CLI, bundled in the image).

## How it works

1. Reads `skill-sync.config.json` from the repo root (the one you mounted in).
2. Clones the destination repo (or reuses a sibling checkout, for local runs).
3. Diffs your skill folder against it — copies changed files, removes ones
   deleted at the source. If nothing changed, it exits, no PR opened.
4. Otherwise commits on a `sync/<repo>-<date>-<sha>` branch, pushes, and opens
   a PR. Re-running the same day updates that PR instead of erroring or
   duplicating it.

## Configure

Add `skill-sync.config.json` to the root of the repo you're syncing *from*:

```json
{
  "source": "packages/kairos-skill",
  "destRepo": "TheKimDevs/kairos-skill",
  "localDestPath": "../kairos-skill"
}
```

| Field | Required | Description |
|---|---|---|
| `source` | yes | Relative path to the skill folder in this repo. |
| `destRepo` | yes | `owner/repo` slug (or full git URL) of the published skill repo. |
| `localDestPath` | no | A sibling checkout to sync into directly, for fast local iteration. Ignored (falls back to cloning `destRepo` into a temp dir) if the path doesn't exist — always the case in CI. |
| `prTitle` | no | Overrides the default PR title / commit message. |
| `prBodyIntro` | no | Overrides the first line of the PR body. |

## What you need

A GitHub token with **Contents: Read & write** and **Pull requests: Read &
write** scoped to `destRepo` — a fine-grained personal access token works
well. Store it as a CI secret (examples below call it `SKILL_SYNC_TOKEN`) and
pass it through as the `GH_TOKEN` env var; the image's entrypoint wires `gh`
and `git` to use it automatically.

## Usage

### GitHub Actions

No devDependency, no `pnpm install`, no `setup-node` — the image *is* the
dependency:

```yaml
name: Sync my-skill

on:
  push:
    branches: [main]
    paths: ["packages/my-skill/**"]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker://ghcr.io/kerubi-5/skill-sync:latest
        env:
          GH_TOKEN: ${{ secrets.SKILL_SYNC_TOKEN }}
```

`actions/checkout` mounts the repo at `/github/workspace`, which is where the
container looks for `skill-sync.config.json` by default.

### GitLab CI

```yaml
sync-skill:
  image:
    name: ghcr.io/kerubi-5/skill-sync:latest
    entrypoint: [""]
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      changes:
        - packages/my-skill/**
  script:
    - /app/entrypoint.sh
  variables:
    GH_TOKEN: $SKILL_SYNC_TOKEN
```

(GitLab CI runs `script:` instead of the image's entrypoint by default —
`entrypoint: [""]` plus calling it explicitly in `script:` works around that.)

### CircleCI

```yaml
jobs:
  sync-skill:
    docker:
      - image: ghcr.io/kerubi-5/skill-sync:latest
    steps:
      - checkout
      - run: /app/entrypoint.sh
```

Set `SKILL_SYNC_TOKEN` as a project environment variable and reference it as
`GH_TOKEN` (CircleCI env vars are already available as `GH_TOKEN` if you name
it that directly, or alias it in the job).

### Plain `docker run` (local testing, Jenkins, Buildkite, anything else)

```bash
docker run --rm \
  -v "$(pwd):/github/workspace" \
  -w /github/workspace \
  -e GH_TOKEN="$(gh auth token)" \
  ghcr.io/kerubi-5/skill-sync:latest --dry-run
```

Drop `--dry-run` to actually push and open the PR. This is the same path CI
takes, so it's a reliable way to check a config change before trusting it in
a real pipeline.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GH_TOKEN` | yes (unless `--dry-run` against a repo you can already read) | Token `gh`/`git` use to push and open the PR. |
| `GITHUB_REPOSITORY` | auto-set by GitHub Actions | Used to name the sync branch/PR after the actual source repo. Without it (or the GitLab/CircleCI equivalents), falls back to the mounted directory's name — which inside most CI containers is a generic path like `/github/workspace`, so branch names would all read `sync/workspace-...`. Set it manually if your CI doesn't provide an equivalent. |
| `SKILL_SYNC_GIT_NAME` / `SKILL_SYNC_GIT_EMAIL` | no | Commit author on the sync branch. Defaults to `skill-sync-bot` / `skill-sync-bot@users.noreply.github.com`. |

## Troubleshooting

- **`detected dubious ownership in repository`** — shouldn't happen; the
  entrypoint runs `git config --global --add safe.directory '*'` before
  anything else, since the mounted repo is essentially never owned by the
  container's UID.
- **`fatal: could not read Username for 'https://github.com'`** — means
  `GH_TOKEN` wasn't set, or a step ran `git push`/`git pull` directly without
  going through the image's entrypoint (which runs `gh auth setup-git` to
  wire the token into git's own credential helper — `gh` subcommands pick up
  `GH_TOKEN` on their own, but plain `git` commands don't unless this runs
  first).
- **Branch name / PR title says "sync/workspace-..."** — see the
  `GITHUB_REPOSITORY` row above.
- **PR opened yesterday, ran again today, now two PRs?** — shouldn't happen;
  a same-day rerun reuses and force-pushes the existing branch, updating the
  existing PR. Different *days* intentionally get separate branches/PRs.

## License

MIT
