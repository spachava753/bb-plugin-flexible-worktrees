/**
 * Normalize a Git remote URL (https, ssh, scp-like, or bare host/path) to `host/path`, with a
 * lowercase host and no trailing `.git`. Never contacts the remote or keeps credentials.
 * Pure: shared by the server (project templates) and the host (gh repository identity).
 */
export function remoteIdentity(remote: string | null | undefined): string | null {
  if (!remote) return null;
  let host: string, path: string;
  if (remote.includes("://")) {
    try {
      const url = new URL(remote);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
      host = url.hostname; path = url.pathname;
    } catch { return null; }
  } else {
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(remote);
    if (scp) { host = scp[1]!; path = scp[2]!; }
    else {
      const identity = /^([^/:]+)\/(.+)$/.exec(remote);
      if (!identity) return null;
      host = identity[1]!; path = identity[2]!;
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !path || /[\\\s]/.test(host + path) || path.split("/").some(p => !p || p === "." || p === "..")) return null;
  return `${host.toLowerCase()}/${path}`;
}
