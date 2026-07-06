#!/usr/bin/env node
/**
 * skill-sync — syncs a skill package folder from a source repo into its
 * dedicated published repo, then opens a PR there with the diff.
 *
 * Reads `skill-sync.config.json` from the current working directory (the
 * source repo's root). Config fields:
 *   source        (required) relative path to the skill folder, e.g. "packages/kairos-skill"
 *   destRepo      (required) "owner/repo" slug or full git URL of the published skill repo
 *   localDestPath (optional) sibling checkout to sync into directly (fast local iteration);
 *                 falls back to cloning destRepo into a temp dir (used in CI)
 *   prTitle       (optional) PR title template
 *   prBodyIntro   (optional) first line of the PR body
 *
 * Requires the `gh` CLI, authenticated with push + PR-create rights on destRepo
 * (in CI: `gh` picks up the `GH_TOKEN` env var automatically).
 */
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const configArgIndex = args.indexOf("--config")
const configPath =
  configArgIndex !== -1 && args[configArgIndex + 1]
    ? args[configArgIndex + 1]
    : "skill-sync.config.json"

const sourceRepoRoot = process.cwd()

function run(cwd, command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  })
  if (result.status !== 0) {
    if (options.allowFailure) return ""
    const stderr = result.stderr?.trim()
    console.error(
      stderr
        ? `Command failed: ${command} ${commandArgs.join(" ")}\n${stderr}`
        : `Command failed: ${command} ${commandArgs.join(" ")}`
    )
    process.exit(result.status === null ? 1 : result.status)
  }
  return result.stdout?.trim() ?? ""
}

function loadConfig() {
  const fullPath = isAbsolute(configPath)
    ? configPath
    : join(sourceRepoRoot, configPath)
  if (!existsSync(fullPath)) {
    console.error(`Missing config file: ${fullPath}`)
    process.exit(1)
  }
  const config = JSON.parse(readFileSync(fullPath, "utf8"))
  if (!config.source || !config.destRepo) {
    console.error(`${configPath} must set "source" and "destRepo"`)
    process.exit(1)
  }
  return config
}

function normalizeDestSlug(destRepo) {
  // Accepts "owner/repo" or a full git/https URL and returns "owner/repo".
  const match = /([^/:]+\/[^/]+?)(?:\.git)?$/.exec(destRepo.trim())
  if (!match) {
    console.error(`Could not parse destRepo: ${destRepo}`)
    process.exit(1)
  }
  return match[1]
}

/** Copies `source` into `destination`, removing dest paths no longer in source. Preserves .git. */
function syncTree(source, destination) {
  mkdirSync(destination, { recursive: true })
  const sourceEntries = new Set(readdirSync(source))
  for (const name of sourceEntries) {
    const from = join(source, name)
    const to = join(destination, name)
    if (statSync(from).isDirectory()) {
      syncTree(from, to)
    } else {
      cpSync(from, to)
    }
  }
  for (const name of readdirSync(destination)) {
    if (name === ".git" || sourceEntries.has(name)) continue
    rmSync(join(destination, name), { recursive: true, force: true })
  }
}

function sourceRepoShortSha() {
  if (!existsSync(join(sourceRepoRoot, ".git"))) return null
  return run(sourceRepoRoot, "git", ["rev-parse", "--short", "HEAD"]) || null
}

function sourceRepoName() {
  const toplevel = run(sourceRepoRoot, "git", ["rev-parse", "--show-toplevel"])
  return toplevel ? toplevel.split("/").pop() : "source"
}

function resolveDestDir(config, destSlug) {
  const localPath = config.localDestPath
    ? join(sourceRepoRoot, config.localDestPath)
    : null

  if (localPath && existsSync(localPath)) {
    if (!existsSync(join(localPath, ".git"))) {
      console.error(`localDestPath is not a git repo: ${localPath}`)
      process.exit(1)
    }
    const dirty = run(localPath, "git", ["status", "--porcelain"])
    if (dirty) {
      console.error(
        `${config.localDestPath} has uncommitted changes — commit or stash them first.`
      )
      process.exit(1)
    }
    return { dir: localPath, isTemp: false }
  }

  const tempDir = mkdtempSync(join(tmpdir(), "skill-sync-"))
  console.log(`Cloning ${destSlug} into ${tempDir}…`)
  run(dirname(tempDir), "gh", ["repo", "clone", destSlug, tempDir], {
    inherit: true,
  })
  return { dir: tempDir, isTemp: true }
}

function main() {
  const config = loadConfig()
  const sourceDir = join(sourceRepoRoot, config.source)
  if (!existsSync(sourceDir)) {
    console.error(`Missing source directory: ${sourceDir}`)
    process.exit(1)
  }

  const destSlug = normalizeDestSlug(config.destRepo)
  const { dir: destDir, isTemp } = resolveDestDir(config, destSlug)

  const defaultBranch =
    run(destDir, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      .replace(/^origin\//, "")
      .trim() || "main"
  run(destDir, "git", ["checkout", defaultBranch], { inherit: true })
  run(destDir, "git", ["pull", "--ff-only", "origin", defaultBranch], {
    inherit: true,
  })

  const repoName = sourceRepoName()
  const sha = sourceRepoShortSha()
  const date = new Date().toISOString().slice(0, 10)
  const branch = `sync/${repoName}-${date}${sha ? `-${sha}` : ""}`
  const commitMessage =
    config.prTitle ??
    (sha
      ? `Sync skill from ${repoName} (${sha})`
      : `Sync skill from ${repoName}`)

  // Reset to (or create) the branch from defaultBranch's tip before writing
  // the sync, so a rerun on an already-synced branch never conflicts with
  // dirty content left on defaultBranch's own working tree.
  run(destDir, "git", ["checkout", "-B", branch, defaultBranch], {
    inherit: true,
  })

  syncTree(sourceDir, destDir)

  const dirty = run(destDir, "git", ["status", "--porcelain"])
  if (!dirty) {
    console.log("Nothing to sync — destination already up to date.")
    run(destDir, "git", ["checkout", defaultBranch])
    if (isTemp) rmSync(destDir, { recursive: true, force: true })
    return
  }

  const changedFiles = dirty
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
  const prBody = [
    config.prBodyIntro ??
      `Automated sync from \`${config.source}\` in the ${repoName} repo.`,
    sha ? `\nSource commit: \`${sha}\`` : "",
    "\nChanged files:",
    ...changedFiles.map((file) => `- ${file}`),
  ]
    .filter(Boolean)
    .join("\n")

  if (dryRun) {
    console.log("[dry-run] Would open a PR with these changes:")
    console.log(dirty)
    console.log(`[dry-run] Branch: ${branch}`)
    console.log(`[dry-run] Commit: ${commitMessage}`)
    run(destDir, "git", ["checkout", defaultBranch])
    if (isTemp) rmSync(destDir, { recursive: true, force: true })
    return
  }

  run(destDir, "git", ["add", "-A"], { inherit: true })
  run(destDir, "git", ["commit", "-m", commitMessage], { inherit: true })
  run(destDir, "git", ["push", "--force", "-u", "origin", branch], {
    inherit: true,
  })

  const existingPr = run(
    destDir,
    "gh",
    ["pr", "view", branch, "--repo", destSlug, "--json", "url", "--jq", ".url"],
    { allowFailure: true }
  )
  if (existingPr) {
    console.log(`Updated existing PR: ${existingPr}`)
  } else {
    run(
      destDir,
      "gh",
      [
        "pr",
        "create",
        "--repo",
        destSlug,
        "--base",
        defaultBranch,
        "--head",
        branch,
        "--title",
        commitMessage,
        "--body",
        prBody,
      ],
      { inherit: true }
    )
  }

  if (isTemp) rmSync(destDir, { recursive: true, force: true })
}

main()
