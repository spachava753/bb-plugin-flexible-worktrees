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

The panel under the list says in one sentence what launching will do and shows warnings, for example unpushed commits. Conflicts that can be predicted, such as an existing branch name, a missing branch, or an occupied folder, block launch here instead of failing the environment later. Where new worktrees go comes from the project's [path template](#destinations). **Location** overrides the template's parent directory or folder name for one thread.

Branches render instantly from local refs. Opening the picker also queries the remotes (`git ls-remote`, adding *not fetched* rows) and `gh` (pull requests); **Refresh** repeats both. Without `gh` the Pull requests group is hidden, though `#123` still works on GitHub and GitLab remotes through their pull/merge-request refs. If `gh` is installed but signed out, the picker says to run `gh auth login`. Fork PRs need no extra remote.

Every fetch requests a single ref, with no tags, pruning, or submodules. Remote access uses the selected machine's existing Git credentials. The plugin never pushes.

Paths are resolved on the selected machine, not necessarily the machine running the BB server. No shell expansion is performed except a leading `~`.

### Settings

Under **Settings → Installed plugins → Flexible Worktrees**, or with `bb plugin config flexible-worktrees set <key> <value>`:

- `pathTemplate` (default `~/worktrees/{pathKey}`): where new worktrees go. See [Destinations](#destinations).
- `projectOverrides` (default `{}`): per-project templates. See [Per-project templates](#per-project-templates).
- `initSubmodules` (default `true`): runs `git submodule update --init --recursive` in new worktrees.

Settings are read on each creation; no reload is required.

## Destinations

`pathTemplate` is the **complete path, including the new worktree's folder name**. Unset, empty, or whitespace-only uses `~/worktrees/{pathKey}`, which gives each launch a unique folder. The settings page has a **Template reference** with common layouts.

```sh
# Grouped by repository
bb plugin config flexible-worktrees set pathTemplate '~/worktrees/{repo}/{pathKey}'

# Siblings of each source checkout, named after repository and branch
bb plugin config flexible-worktrees set pathTemplate '{checkoutParent}/{repo}.{branch}'
```

For a source checkout `/home/user/GIT/app`, branch `feature/login`, and launch key `thr_abc123`:

| Variable | Meaning | Expanded value |
| --- | --- | --- |
| `{repo}` | Primary checkout directory's name, even if BB's source is a linked worktree | `app` |
| `{repoPath}` | Absolute, canonical root of BB's source checkout on the selected machine | `/home/user/GIT/app` |
| `{checkoutParent}` | Parent directory of that source checkout | `/home/user/GIT` |
| `{branch}` | The worktree's **local** branch, sanitized for the filesystem; detached PR worktrees use `pr-<number>`. The Git branch name is unchanged | `feature-login` |
| `{pathKey}` | BB's unique launch key, assigned at launch | `thr_abc123` |

Templates are expanded by substituting each variable, expanding a leading `~` to the selected machine's home, and resolving a relative path from `{repoPath}`:

| Template | Result for the example above |
| --- | --- |
| `~/worktrees/{pathKey}` | `/home/user/worktrees/thr_abc123` |
| `~/worktrees/{repo}/{pathKey}` | `/home/user/worktrees/app/thr_abc123` |
| `{checkoutParent}/{repo}.{branch}` | `/home/user/GIT/app.feature-login` |
| `../{repo}.{branch}` | `/home/user/GIT/app.feature-login` |
| `{repoPath}/.worktrees/{branch}` | `/home/user/GIT/app/.worktrees/feature-login` |

For `{branch}`, `/`, `\`, and filesystem-reserved punctuation become `-`. Only the listed single-brace variables are supported, not shell variables or filters; unknown variables are rejected. Nothing is appended to the expanded template. If a folder made from the template already exists, `-2`, `-3`… is appended. An explicit **Folder name** that already exists is refused. Names BB assigns at launch (an automatic branch, `{pathKey}`) appear as `<automatic …>` placeholders in the picker's preview.

**Location** overrides parts of the template for one thread: **Parent directory** (variables allowed; it must expand to an absolute path or `~/path`) and **Folder name** (one literal name). Blank fields keep the template's parts, and defaults are never copied into the thread's inputs. `path` targets ignore templates.

### Per-project templates

Set `projectOverrides` to a JSON object mapping BB project IDs or remote identities to full templates. This is user configuration stored by BB, never a file committed to the repository:

```json
{
  "github.com/my-org/*": "{repoPath}/.worktrees/{branch}",
  "proj_example": "~/special/{repo}/{pathKey}"
}
```

```sh
bb plugin config flexible-worktrees set projectOverrides '{"github.com/my-org/*":"{repoPath}/.worktrees/{branch}"}'
```

Remote matches use BB's saved project remote URL; no network lookup is performed. HTTPS, SSH, and scp-style Git URLs normalize to `host/owner/repo`, with a lowercase host and without the trailing `.git`. URL keys are accepted too. `*` matches any characters. A project-ID entry wins over remote entries, exact remote matches win over wildcards, and otherwise the pattern with the most non-wildcard characters wins. Equal-specificity matches use lexical key order. Without a matching entry, the global `pathTemplate` applies. An empty project entry uses the built-in default `~/worktrees/{pathKey}` for that project.

### Preparing new worktrees

After creating a worktree the plugin:

1. Initializes submodules, if `.gitmodules` exists and the setting is on.
2. Copies untracked files listed in a tracked `.worktreeinclude`, using the same gitignore-style format as BB's built-in Worktree provider. It copies files only, follows no symlinks, and never replaces a file the worktree already has.

Then BB runs the repository's `.bb-env-setup.sh` as usual. Problems in these steps are reported in the provisioning transcript and don't stop the launch. They run once per worktree, never again on retries or rebuilds.

## Retention and safety

**The plugin never removes directories or branches.** Archiving or deleting a thread, or explicitly deleting its environment, keeps the files. Cancelled or failed creation may also leave a worktree or branch. Agents and users manage worktrees with Git: `git worktree list`, and `git worktree remove /absolute/path` (without `--force`) when done.

- Attached checkouts are never mutated and never owned. Attaching a path that another provider's BB environment manages (and might remove) is refused; reuse that environment instead. So is attaching a checkout that another provider's environment in the same project already uses, since BB allows one provider per checkout: reuse that environment, or delete it with `bb environment delete <id>` once its threads are archived.
- Restoring a destroyed environment (BB versions with environment restore) reattaches the files it left behind. A created worktree is found through its ownership receipt and must still be the same worktree; if it was removed outside BB, restore fails without creating a replacement or changing anything. An attached checkout is resolved again from its inputs: a path attaches the same path, and a branch attaches the checkout that has it now (never a new worktree).
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

Creating targets accept `"location": { "root": "~/wt/{repo}", "folder": "x" }` to override the path template's parent directory (variables allowed) or folder name (one literal name). `remote` defaults to `origin`, or the only remote.

```sh
bb thread spawn --project <project-id> \
  --environment-provider flexible-worktrees \
  --environment-inputs '{"target":"pr","number":123}' \
  --prompt 'Review this PR'
```

### Upgrading from 0.2.x

- Environment inputs are now intent-level targets. Earlier inputs (`"mode": ...`) are no longer accepted, and rebuilding an environment created by an earlier version fails without touching its files. Start a new thread with `{"target":"path","path":"<old worktree>"}` instead.
- `pathTemplate` and `projectOverrides` keep working unchanged. A folder made from the template that already exists now gets `-2`, `-3`… instead of being refused.
- Git installs tracking `^0.2.0` do not select 0.3.x. Change the source range to `^0.3.0`. Don't remove the installed plugin just to change its range: removal deletes its BB settings.

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
