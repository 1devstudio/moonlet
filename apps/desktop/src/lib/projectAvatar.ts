/** GitHub owner avatars for projects in the sidebar (X15). */

/** GitHub user and organization names: up to 39 letters, digits and hyphens, not starting or ending with a hyphen. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

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

/** The avatar of a project's GitHub owner from its identity's normalised
 * origin (`github.com/acme/storefront`), on GitHub's avatar host, which the
 * phone's CSP allows (X118). */
export function identityAvatar(origin: string | null): string | null {
  const [host, owner] = origin?.split("/") ?? [];
  return host === "github.com" && owner && OWNER.test(owner) ? `https://avatars.githubusercontent.com/${owner}?s=64` : null;
}
