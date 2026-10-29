import { DEFAULT_PATH_TEMPLATE } from "./inputs";

/** Settings help for pathTemplate and projectOverrides. Static: it reads and changes nothing. */

const examples = [
  { label: "Default", template: DEFAULT_PATH_TEMPLATE },
  { label: "Grouped by repo", template: "~/worktrees/{repo}/{pathKey}" },
  { label: "Beside checkout", template: "{checkoutParent}/{repo}.{branch}" },
];
const variables = [
  { name: "repo", meaning: "Primary checkout directory name, even when the source is a linked worktree.", example: "app" },
  { name: "repoPath", meaning: "Absolute source checkout root on the selected machine.", example: "/home/user/GIT/app" },
  { name: "checkoutParent", meaning: "Parent directory of that source checkout.", example: "/home/user/GIT" },
  { name: "branch", meaning: "The worktree's local branch, sanitized for the filesystem; detached PR worktrees use pr-<number>. The Git branch name is unchanged.", example: "feature/login becomes feature-login" },
  { name: "pathKey", meaning: "BB's unique launch key. Include it to avoid destination-name collisions.", example: "thr_abc123" },
];

export function TemplateReference() {
  return <div className="grid gap-3 text-sm text-foreground">
    <section aria-label="Common path layouts" className="overflow-hidden rounded-lg border border-border">
      <dl className="divide-y divide-border">
        {examples.map(example => <div key={example.label} className="grid gap-1.5 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-baseline sm:gap-3">
          <dt className="font-medium">{example.label}</dt>
          <dd className="min-w-0"><code className="break-all font-mono text-xs select-all">{example.template}</code></dd>
        </div>)}
      </dl>
    </section>
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer rounded-lg px-3 py-2.5 font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Variables and path rules</summary>
      <div className="grid gap-4 border-t border-border p-3">
        <dl className="grid gap-3">
          {variables.map(variable => <div key={variable.name} className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
            <dt><code className="font-mono text-xs">{`{${variable.name}}`}</code></dt>
            <dd className="min-w-0 text-xs leading-relaxed">
              <p>{variable.meaning}</p>
              <p className="mt-1 break-all font-mono text-muted-foreground">{variable.example}</p>
            </dd>
          </div>)}
        </dl>
        <div className="grid gap-2 border-t border-border pt-3 text-xs leading-relaxed">
          <p>The template is the complete path, including the folder name. Nothing is appended to it.</p>
          <p>For checkout <code className="break-all font-mono">/home/user/GIT/app</code> and branch <code className="font-mono">feature/login</code>, the sibling example produces:</p>
          <code className="break-all rounded-md bg-muted px-2 py-1.5 font-mono">/home/user/GIT/app.feature-login</code>
          <p><code className="font-mono">~</code> uses the selected machine’s home directory. Relative paths resolve from <code className="font-mono">{`{repoPath}`}</code>.</p>
          <p>Use single-brace variables, not shell variables or Worktrunk filters. Branch separators and filesystem-reserved characters become <code className="font-mono">-</code>.</p>
          <p>If a folder made from the template already exists, <code className="font-mono">-2</code>, <code className="font-mono">-3</code>… is appended. An explicit Folder name that already exists is refused.</p>
          <p>Automatic names are assigned at launch. The composer’s Location fields override the parent directory and folder name for one thread.</p>
        </div>
      </div>
    </details>
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer rounded-lg px-3 py-2.5 font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Per-project override examples</summary>
      <div className="grid gap-3 border-t border-border p-3 text-xs leading-relaxed">
        <p>Map a BB project ID or remote identity to a complete template using the same variables:</p>
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono">{JSON.stringify({
          "github.com/my-org/*": "{checkoutParent}/{repo}.{branch}",
          "proj_example": "~/special/{repo}/{pathKey}",
        }, null, 2)}</pre>
        <p>Project IDs win over remote matches. Exact remotes win over wildcards, then the most specific pattern wins. Equal matches use lexical key order.</p>
        <p>HTTPS and SSH remote URLs normalize to <code className="font-mono">host/owner/repo</code>, without a trailing <code className="font-mono">.git</code>. Matching uses BB’s saved project URL, without network access.</p>
        <p>No match uses the global template. An empty value uses <code className="font-mono">{DEFAULT_PATH_TEMPLATE}</code> for that project. Overrides stay in your BB settings, never in the repository.</p>
      </div>
    </details>
  </div>;
}
