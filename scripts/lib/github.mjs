// A minimal GitHub REST client on top of an injected fetch. Used by the
// automation scripts with the workflow's GITHUB_TOKEN; no other credentials.

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{fetch: typeof fetch, token: string, repo: string, apiUrl?: string}} options
 *   repo is "owner/name"
 */
export function createClient({ fetch, token, repo, apiUrl = 'https://api.github.com' }) {
  async function request(method, path, body) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new GitHubError(res.status, `${method} ${path} failed with HTTP ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  const base = `/repos/${repo}`;
  return {
    request,
    getPull: (number) => request('GET', `${base}/pulls/${number}`),
    listPullFiles: (number) => request('GET', `${base}/pulls/${number}/files?per_page=100`),
    listOpenIssues: (label) => request('GET', `${base}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`),
    listComments: (number) => request('GET', `${base}/issues/${number}/comments?per_page=100`),
    createIssue: (issue) => request('POST', `${base}/issues`, issue),
    createComment: (number, body) => request('POST', `${base}/issues/${number}/comments`, { body }),
    /** A file's text at a commit. */
    getFileText: async (path, ref) => {
      const file = await request('GET', `${base}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      return Buffer.from(file.content, 'base64').toString('utf8');
    },
    getCommit: (sha) => request('GET', `${base}/git/commits/${sha}`),
    createTree: (tree) => request('POST', `${base}/git/trees`, tree),
    createCommit: (commit) => request('POST', `${base}/git/commits`, commit),
    /** Moves a branch to sha; GitHub refuses unless it is a fast-forward. */
    fastForward: (branch, sha) => request('PATCH', `${base}/git/refs/heads/${branch}`, { sha, force: false }),
  };
}
