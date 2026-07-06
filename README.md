# skill-sync

Syncs a skill package folder from a source repo (e.g. a monorepo like `kairos`)
into its dedicated published repo (e.g. `kairos-skill`), then opens a pull
request there with the diff. Built to be shared across repos that each publish
one skill package out of a larger app repo.

## Install

Add as a dev dependency via git (no npm registry involved):

```jsonc
// package.json
"devDependencies": {
  "skill-sync": "github:Kerubi-5/skill-sync"
}
```

## Configure

Add `skill-sync.config.json` to the source repo's root:

```json
{
  "source": "packages/kairos-skill",
  "destRepo": "TheKimDevs/kairos-skill",
  "localDestPath": "../kairos-skill"
}
```

- `source` — relative path to the skill folder in this repo.
- `destRepo` — `owner/repo` slug (or full git URL) of the published skill repo.
- `localDestPath` *(optional)* — a sibling checkout to sync into directly for
  fast local iteration. When missing or not checked out, `skill-sync` clones
  `destRepo` into a temp directory instead (the path CI always takes).

## Run

```bash
npx skill-sync              # sync + open a PR in destRepo
npx skill-sync --dry-run    # show what would change, without pushing
```

Requires the `gh` CLI, authenticated with push + PR-create rights on
`destRepo`. In CI, `gh` picks up the `GH_TOKEN` env var automatically — set a
repo secret holding a token scoped to `destRepo` and pass it through:

```yaml
- run: npx skill-sync
  env:
    GH_TOKEN: ${{ secrets.SKILL_SYNC_TOKEN }}
```

## Behavior

- Diffs the source folder against the destination, copying changed files and
  removing ones deleted at the source (`.git` is always preserved).
- If nothing changed, exits without opening a PR.
- Otherwise commits on a new `sync/<repo>-<date>-<sha>` branch, pushes, and
  opens a PR against the destination's default branch. Nothing lands on
  destRepo's default branch without a human merging the PR.
