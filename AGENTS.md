# Flexible Worktrees

BB environment provider with server (`server.ts`), host worker (`host.ts`), shared schemas (`inputs.ts`), server/host RPC contracts (`contract.ts`), project-template selection (`settings.ts`, with remote URL normalization shared with the host in `remotes.ts`), settings help (`TemplateReference.tsx`; keep declarative setting descriptions concise), and a new-thread input slot (`app.tsx`). Inputs are intent-level targets (`new`, `branch`, `pr`, `path`); one host `plan` function resolves them for the picker preview, `validate()`, and `create()`, so keep resolution there and keep it free of ref/config/file writes.

Host modules live in `worktree/`: `git.ts` (the `repo(dir, signal)` handle; all Git runs through it, with argv), `refs.ts` (ref naming and branch lookups), `github.ts` (optional `gh`), `plan.ts` (one planner per target sharing a context), `destination.ts` (path templates and per-thread overrides), `create.ts` (resume, prepare, checkout, finish), `provision.ts`, `receipts.ts`, `choices.ts` (picker listings), and `fs.ts`. Picker modules live in `picker/`: `options.tsx` (pure option model: sections and what selecting each does), `Listbox.tsx` (keyboard/listbox hook and view), `Details.tsx`, `describe.ts` (user-facing copy), `data.ts` (RPC hooks), and `parts.tsx`. `WorktreePicker.tsx` composes them into the compact trigger and portalled "Work on…" popover; keep the composer footer limited to the trigger, and keep all form buttons non-submitting. Vendored UI controls live in `components/ui`.

Use npm and the checked-in lockfile. Run `npm run check` before finishing a change. Tests use temporary Git repositories plus the public BB SDK harnesses. Build all three bundles before installing/reloading. Use `bb plugin types` to check the SDK version when upgrading BB. Before a release, also build a clean copy after `npm ci --omit=dev --omit=optional --ignore-scripts`: Git installs omit development dependencies. Browser modules must import schemas from `inputs.ts`, not the server/host contract module, which imports SDK runtime helpers.

Safety contract:
- Attached checkouts (`path` target, or a branch already checked out) never mutate Git, claim directory ownership, or remove files.
- Existing branches move only by a verified fast-forward (`merge --ff-only`), run inside the new worktree after it has checked the branch out. The only refs ever overwritten are the plugin-private `refs/flexible-worktrees/pr/<remote>/<n>`.
- Provisioning (submodules, `.worktreeinclude`) runs once per created worktree, never overwrites files, and never fails the launch.
- The provider never deletes directories or branches, including cancellation/cleanup.
- Refuse existing destinations unless the path-key ownership receipt and Git worktree identity match a prior create. Retries reuse the receipt's plan.
- `restore` only reattaches what a prior create left at the same path (receipt-verified worktree, or the same attached checkout); it never creates a replacement.
- Claim canonical destination paths through core before mutation. Run Git with argv, not a shell.
- Keep lifecycle state in BB core. Host receipts identify filesystem ownership only.
- Do not silently change retention policy or enable destructive cleanup.
- `pathTemplate` is the sole global destination setting; unset/blank templates use `~/worktrees/{pathKey}`. Do not reintroduce a separate default root. Thread Location fields override the parent and folder independently; never materialize defaults into persisted inputs. Previews show launch-time names as placeholders; launches must resolve them.
- Project template precedence is project ID, exact remote identity, most-specific remote wildcard, then the global template. Remote matching uses BB's saved project URL without network access.

The plugin is separate from the built-in Worktree provider. Do not disable that provider or migrate existing environments as part of ordinary development. No remote GitHub repository is required to install this local plugin.
