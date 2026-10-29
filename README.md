# Flexible Worktrees for BB

A new-thread environment provider where you pick **what** to work on (a pull request, a branch, an existing checkout, or a new task) and the plugin picks the Git steps: attach, check out, fetch and track, or create a branch. Requires BB 0.43+, Plugin SDK 0.4.87+, and Git 2.31+ on the selected machine. The GitHub CLI (`gh`) is optional.

## Install

```sh
bb plugin install 'git:https://github.com/spachava753/bb-plugin-flexible-worktrees.git@^0.3.0'
```

Git-source installation builds the plugin locally. BB asks for confirmation because plugins run with full trust.

## Use

Select a project and machine in **New thread**, then select **Flexible Worktrees** in the environment picker. The button beside it shows the current target, such as `New branch from origin/main`, `#123 Fix login`, or `feature/x · attached`. Click it to open **Work on…**, a single search box over four groups:

| Group | Pick it to… | What happens at launch |
|---|---|---|
| **New** | Start a task | A new branch from the freshly fetched remote default branch (`origin/main`), or from the **Base** you choose. Blank names use BB's suggested branch name. The branch has no upstream; publish with `git push -u origin HEAD`. |
| **Pull requests** | Review or continue a PR | Fetches the PR head into a detached worktree (**Detached (review)**, the default). **Branch (can push)** checks out the PR's branch instead (same-repo PRs only). Type `#123` to fetch any PR by number. |
| **Branches** | Resume or review a branch | Local and remote branches merged into one row each, newest first. A branch already checked out somewhere attaches that worktree. A local branch gets a new worktree and is **fast-forwarded** to its upstream by default when it's behind. A remote-only branch is fetched and tracked. |
| **Worktrees** | Reuse a checkout | Attaches a detached worktree, or any checkout path you enter, exactly as it is. |

The panel under the list says in one sentence what launching will do and shows warnings, for example unpushed commits. Conflicts that can be predicted, such as an existing branch name, a missing branch, or an occupied folder, block launch here instead of failing the environment later. **Location** sets the parent directory and folder name. Folders are named after the branch (`feature/x` → `feature-x`, PRs → `pr-123`) and get `-2`, `-3`… on collision.

Branches render instantly from local refs. Opening the picker also queries the remotes (`git ls-remote`, adding *not fetched* rows) and `gh` (pull requests); **Refresh** repeats both. Without `gh` the Pull requests group is hidden, though `#123` still works on GitHub and GitLab remotes through their pull/merge-request refs. If `gh` is installed but signed out, the picker says to run `gh auth login`. Fork PRs need no extra remote.

Every fetch requests a single ref, with no tags, pruning, or submodules. Remote access uses the selected machine's existing Git credentials. The plugin never pushes.

Paths are resolved on the selected machine, not necessarily the machine running the BB server. No shell expansion is performed except a leading `~`.

### Settings

Under **Settings → Installed plugins → Flexible Worktrees**, or with `bb plugin config flexible-worktrees set <key> <value>`:

- `defaultRoot` (default `~/dev/worktrees/{repo}`): the parent directory for new worktrees. `{repo}` expands to the primary checkout's directory name.
- `initSubmodules` (default `true`): runs `git submodule update --init --recursive` in new worktrees.

Settings are read on each creation; no reload is required.

### Preparing new worktrees

After creating a worktree the plugin:

1. Initializes submodules, if `.gitmodules` exists and the setting is on.
2. Copies untracked files listed in a tracked `.worktreeinclude`, using the same gitignore-style format as BB's built-in Worktree provider. It copies files only, follows no symlinks, and never replaces a file the worktree already has.

Then BB runs the repository's `.bb-env-setup.sh` as usual. Problems in these steps are reported in the provisioning transcript and don't stop the launch. They run once per worktree, never again on retries or rebuilds.

## Retention and safety

**The plugin never removes directories or branches.** Archiving or deleting a thread, or explicitly deleting its environment, keeps the files. Cancelled or failed creation may also leave a worktree or branch. Agents and users manage worktrees with Git: `git worktree list`, and `git worktree remove /absolute/path` (without `--force`) when done.

- Attached checkouts are never mutated and never owned. Attaching a path that another provider's BB environment manages (and might remove) is refused; reuse that environment instead.
- Newly created worktrees are marked owned so BB runs its normal `.bb-env-setup.sh` and `.bb-env-teardown.sh` hooks. Those repository scripts have their own side effects and are not controlled by this plugin.
- Existing branches only ever move by a fast-forward, which runs inside the new worktree after it has checked the branch out, so the branch can't be checked out elsewhere meanwhile. Diverged branches are used as-is, and fast-forward can be turned off per launch. The only refs the plugin overwrites are its own `refs/flexible-worktrees/pr/<remote>/<n>`.
- Existing destinations are refused, including empty directories. No force/reset/clean commands are used.
- Git runs with argument arrays, never shell interpolation. This does not disable existing Git hooks or filters: creating a worktree runs Git's ordinary checkout behavior.
- Canonical paths are claimed through BB before creation. A plugin-local ownership receipt lets retries reuse the original plan and recognize an already-created worktree without overwriting its files. A mismatched receipt is refused.
- Attached checkouts can be shared, so concurrent agents may edit the same files. Use separate worktrees for isolation.

## CLI

The provider uses BB's normal thread command. `--environment-inputs` takes one of four targets:

```jsonc
{ "target": "new", "branch": "feature/x", "base": "main" }        // branch, base optional
{ "target": "branch", "branch": "feature/x" }                      // add "fastForward": false to keep it as-is
{ "target": "branch", "branch": "x", "remote": "upstream", "localName": "x-upstream" }
{ "target": "pr", "number": 123 }                                  // add "checkout": "branch" to push
{ "target": "path", "path": "~/dev/other-clone" }
```

Creating targets accept `"location": { "root": "~/wt/{repo}", "folder": "x" }`. `remote` defaults to `origin`, or the only remote.

```sh
bb thread spawn --project <project-id> \
  --environment-provider flexible-worktrees \
  --environment-inputs '{"target":"pr","number":123}' \
  --prompt 'Review this PR'
```

Earlier inputs (`"mode": ...`) are no longer accepted. Rebuilding an environment created by an earlier version fails without touching its files. Start a new thread with `{"target":"path","path":"<old worktree>"}` instead.

## Development and installation

```sh
npm ci
npm run check                 # TypeScript, tests, all BB bundles
bb plugin install . --yes     # installs alongside the built-in Worktree provider
```

After editing an installed local plugin, run `npm run check` and `bb plugin reload flexible-worktrees`. Do not disable the built-in provider while existing threads still depend on it.

Tests use temporary local Git repositories and BB's public backend/frontend harnesses. They do not modify personal repositories or start paid agent sessions.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md` for the vendored BB UI notices.

## Alternatives researched

The BB Official and Community catalogs and public GitHub repository search were checked before implementing this:

- Built-in Worktree: installed version exposes a base branch, but no path/folder settings.
- [Worktree shortcut plugin](https://github.com/suiramdev/bb-plugin-worktree): creates standard BB-managed worktrees; its documented prefix setting does not provide arbitrary destination or existing-checkout selection.
- [VCS Widget](https://github.com/CostaFot/bb-plugin-vcs-widget): Git controls inside a thread, including creating worktrees, rather than a configurable new-thread environment provider.
- [Worktree Setup](https://github.com/KaviiSuri/bb-plugin-worktree-setup): provisioning hooks, not checkout selection or placement.
- [Repo Watch](https://github.com/slogsdon/bb-plugin-repo-watch): repository/worktree monitoring.

BB's built-in Project checkout provider also accepts a `path` input through the API/CLI, which covers part of existing-checkout reuse without a new plugin. It does not provide PR, branch, or configurable-path worktree creation.
