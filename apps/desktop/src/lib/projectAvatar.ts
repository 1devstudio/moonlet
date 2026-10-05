/** GitHub owner avatars for projects in the sidebar (X15). */

/** GitHub user and organization names: letters, digits and single hyphens. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The GitHub owner of an `origin` URL (https, ssh or scp-like), if it points at github.com. */
function githubOwner(remote: string): string | null {
  const scp = /^[^/@:]+@github\.com:([^/]+)\//.exec(remote);
  if (scp) return scp[1];
  try {
    const url = new URL(remote);
    if (url.hostname !== "github.com") return null;
    return url.pathname.split("/")[1] ?? null;
  } catch {
    return null;
  }
}

/** The avatar of the account (organization or user) that owns the project's GitHub repo. */
export function avatarUrl(remote: string | null): string | null {
  const owner = remote ? githubOwner(remote.trim()) : null;
  return owner && OWNER.test(owner) ? `https://github.com/${owner}.png?size=64` : null;
}
