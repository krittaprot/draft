# Security

Tandem is meant to be self-hosted, often on the public internet, so security reports matter.

## Reporting a vulnerability

Please report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue.

Include what you found, how to reproduce it, and which version or commit you tested. You'll get a reply as soon as practical, and the fix will credit you unless you'd rather it didn't.

## Scope

Of most interest:
- Bypassing sign-in.
- Getting past the email allowlist or the host-only rule for key sign-in.
- Abusing OAuth for MCP clients.
- Forging share links.
- Reaching other designs or files through the API or MCP tools.
- Server-side request forgery when an image is fetched.
- Script injection in the editor.

The [README](README.md#sign-in-when-its-public) describes how a public deployment is expected to be set up.
