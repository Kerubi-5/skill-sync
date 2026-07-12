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

Whatever CI you use, the container ultimately just needs a `GH_TOKEN` with
**Contents: Read & write** and **Pull requests: Read & write** on `destRepo`.
Two ways to get one — pick based on how much setup you want:

- **A GitHub App installation token (recommended).** Short-lived (~1 hour,
  minted fresh per run), scoped to exactly the repos it's installed on, shows
  up in history as its own bot identity rather than a person's account, and
  never needs manual rotation. More setup up front; see below.
- **A fine-grained personal access token.** Two minutes in the browser
  (Settings → Developer settings → Fine-grained tokens → pick `destRepo`,
  grant those two permissions), store the value directly as a secret. Simpler,
  but it's a standing credential you'll need to remember to renew before it
  expires.

Either way, store the result as a CI secret and pass it through as `GH_TOKEN`
— the image's entrypoint wires `gh` and `git` to use it automatically.

### Setting up the GitHub App (one-time, reusable across every repo pair)

1. **Create the App** — in the org or account that owns your destination
   repo(s) (e.g. `github.com/organizations/<org>/settings/apps/new`):
   - Disable the webhook ("Active" checkbox off — not needed here).
   - Repository permissions: **Contents: Read and write**, **Pull requests:
     Read and write**. Leave everything else at no access.
   - Under "Where can this GitHub App be installed?", "Only on this account"
     is enough if all your destination repos live in one place.
2. **Generate a private key** on the App's settings page (Settings → General
   → "Generate a private key") — downloads a `.pem` file. Note the **App ID**
   shown near the top of that page too.
3. **Install the App** (left sidebar → "Install App") on whichever repos it
   needs to push to — you can select multiple.
4. **Add two secrets** to each *source* repo (the one running the sync
   workflow, not the destination) — do this yourself, e.g. via `gh`, so the
   key never has to be pasted anywhere else:
   ```bash
   gh secret set SKILL_SYNC_APP_ID --repo <owner>/<source-repo>
   gh secret set SKILL_SYNC_APP_PRIVATE_KEY --repo <owner>/<source-repo> < path/to/key.pem
   ```
   The same App ID + key work for every source repo whose sync targets a repo
   this App is installed on — you only do steps 1–3 once, ever.

## Usage

### GitHub Actions

No devDependency, no `pnpm install`, no `setup-node` — the image *is* the
dependency. With the GitHub App (recommended):

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
      - id: app-token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ secrets.SKILL_SYNC_APP_ID }}
          private-key: ${{ secrets.SKILL_SYNC_APP_PRIVATE_KEY }}
          owner: my-org
          repositories: my-skill
      - uses: docker://ghcr.io/kerubi-5/skill-sync:latest
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
```

Or, with a plain PAT instead (skip the `app-token` step entirely):

```yaml
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

*(GitLab CI and CircleCI examples above use a plain token for simplicity —
the GitHub App still works from either, it just means minting the
installation token yourself with a `curl`/JWT step instead of the
one-line `actions/create-github-app-token`, since that's GitHub
Actions–specific. See [GitHub's docs on generating installation access
tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
if you want App-based auth outside Actions.)*

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

## Direct commit (skip the PR)

Set `"directCommit": true` in `skill-sync.config.json` (or pass `SKILL_SYNC_DIRECT_COMMIT=true`) to push the sync straight to the destination default branch instead of opening a PR. The push is non-forced, so a concurrent remote change fails loudly rather than being clobbered.
