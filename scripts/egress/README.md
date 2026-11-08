# Per-service egress on the EC2 host

The quota bar's 节点 dialog persists separate selections for Codex, Claude,
Antigravity, Cursor, OpenCode and each third-party API connection. Selections
apply across users of this server. Existing runs capture their route. The
original fixed proxy remains the initial choice; EC2 direct explicitly removes
inherited proxy variables. Selected proxies never retry through direct access.

Each imported node has a stable loopback mixed listener. Ports are assigned once
in `/etc/mintcli-egress/registry.json`. Importing subscriptions ignores their
DNS, TUN, controller, rule, script and group settings; only proxy definitions
are used. Previous listeners remain present across refreshes so existing runs
retain their transport. Removed nodes are unavailable for new runs.

Installed components:

- `mintcli-egress.service`, based on the included unit, runs the installed
  `/usr/local/libexec/cloudcli-mihomo` with systemd credentials and DynamicUser.
- `/usr/local/libexec/mintcli-egress-sync` is an installed copy of `sync.py`.
- `/etc/mintcli-egress/source.json` contains the private subscription URL under
  `url` and the local controller secret under `controllerSecret`. Never serve
  or commit this file. Root owns this directory with mode 0700 and files 0600.
- `/var/lib/cloudcli/egress/inventory.json` contains only node names, stable IDs,
  ports and import provenance. `selection.json` persists routing choices and
  `probes.json` persists measured HTTPS exits, timestamps and failures.
- Local controller `127.0.0.1:17991` requires its secret. Node listeners bind
  only to `127.0.0.1`; none of these endpoints is exposed by nginx.

The authenticated `/api/egress` endpoints list routing, save one choice, probe
one node or refresh the server-configured subscription. They never return
subscription credentials, proxy addresses, authentication data or arbitrary
shell input. A failed refresh leaves the old core config and inventory intact.
The controller payload reload was tested on the installed Mihomo version.

The user restricted the visible inventory to five choices: the existing fixed
egress (labelled 诺联狗根), EC2 direct, New York RackNerd, Ohio AWS 01 and
Ohio AWS 02. `allowedProxyNames` in the private source settings pins these
three subscription nodes across refreshes. The original aggregate stays intact.

On 2026-11-08 the original subscription returned HTTP 404. Initial bootstrap
used the previously validated 2026-11-03 17-node aggregate via the administrative
command `mintcli-egress-sync --snapshot /path/to/private/aggregate.yaml`.
The dialog explicitly identifies this snapshot; subsequent online refreshes
remain available and report failure until the subscription recovers. A current
subscription can be installed by replacing only `url` in the root-owned source
file, then running the sync helper. An invalid candidate is rejected by Mihomo
before publication. Subscription URLs and snapshots must stay outside git.

Antigravity's native bridge reads the same selection at each CLI invocation;
its desktop HTTPS relay receives a captured proxy URL instead of consulting a
mutable process-wide environment. Both the web server and native bridge require
an idle restart to load this implementation. Future selection changes need no
restart. Codex Responses relays, Chat Completions and catalog requests use
explicit per-request Undici dispatchers; changing only child environment
variables would leave these requests on the server's original proxy.

Runtime selections, subscription settings and node credentials are independent
of application source/build rollbacks. Preserve the existing account homes,
Token Monitor plugin files, old frontend chunks and any unrelated source edits.
