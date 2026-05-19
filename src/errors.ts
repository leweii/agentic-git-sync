// Translate raw git/HTTP errors into something a user can act on.
export function friendlyError(raw: string): string {
  if (!raw) return "Unknown error";
  const m = raw.toLowerCase();

  if (m.includes("authentication failed") || m.includes("invalid username or password")) {
    return "Authentication failed — check your Personal Access Token in Settings.";
  }
  if (m.includes("saml") || m.includes("sso")) {
    return "Token needs SSO authorization for this org. Visit GitHub → Settings → Developer settings → PATs and click 'Configure SSO' on this token.";
  }
  if (m.includes("403") && m.includes("github")) {
    // 403 is overloaded: missing scope OR the token's account just doesn't
    // have write access to this repo (most common when helping someone else
    // configure the plugin with YOUR token).
    return "GitHub rejected the request (403). Possible causes: (1) the token's GitHub account isn't a collaborator on this repo, (2) the token is missing 'repo' scope, or (3) the org requires SSO authorization for the token.";
  }
  if (m.includes("404") && (m.includes("not found") || m.includes("repository"))) {
    return "Repository not found, or the token's account can't see it (private repo without access).";
  }
  if (m.includes("could not resolve host") || m.includes("enotfound") || m.includes("network")) {
    return "Network error — check your connection.";
  }
  if (m.includes("would be overwritten by merge") || m.includes("would be overwritten by checkout")) {
    return "Local changes block the pull. Sync again — changes will be committed first.";
  }
  if (m.includes("conflict") || m.includes("merge")) {
    return "Merge conflict. Click Resolve to choose which version to keep.";
  }
  if (m.includes("non-fast-forward") || m.includes("rejected")) {
    return "Remote has newer commits. Pull first or resolve divergence.";
  }
  if (m.includes("permission denied") && m.includes("publickey")) {
    return "SSH key rejected. Use an HTTPS URL with a token instead.";
  }
  if (m.includes("not a git repository")) {
    return "Folder isn't a git repository. Re-run the setup wizard.";
  }
  if (m.includes("locked") || m.includes("index.lock")) {
    return "Git lock file present. Another git process may be running.";
  }
  // Strip noisy prefixes from simple-git
  return raw.replace(/^error:\s*/i, "").replace(/^fatal:\s*/i, "").trim();
}
