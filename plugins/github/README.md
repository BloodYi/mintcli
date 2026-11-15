# GitHub integration

Open the built-in GitHub workspace tab, or Settings → Git. Choose browser login,
copy the device code, and authorize it at `https://github.com/login/device`.
The server needs the official GitHub CLI (`gh` on PATH, or `MINTCLI_GH_PATH`).
Without the CLI, use a GitHub access token with repository Contents read/write
permission. Repositories containing workflow changes also need workflow permission.

Credentials stay on the server and belong to the signed-in mintcli user. Browser
authorization uses an isolated temporary GitHub CLI configuration and removes it
when authorization finishes or is cancelled. Logout deactivates that user's active
GitHub credentials; it does not revoke tokens at GitHub.

The upload preview shows the selected project's repository, local branch, target
branch and exact commit. Commit changes in the Git panel before uploading. Pushes
use the previewed commit, do not force, and stop if the project changed. Remote
updates or branch protection failures remain visible without overwriting them.

This plugin ships with mintcli and can be disabled in plugin settings. It does not
install extensions or change global Git authentication. GitHub pushes from the
existing Git panel reuse the signed-in user's credentials.
