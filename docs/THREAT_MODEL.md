# Product trust and security policy

ae-mcp is local automation for one interactive OS user on the After Effects host. The host user,
the MCP clients they deliberately configure, the selected model backend, and processes running as
that user are trusted to exercise the user's After Effects authority. This is a product boundary,
not a temporary development exception.

The only runtime confidentiality promise is that provider credentials and API secrets do not leak.
The product does not attempt to make a hostile local client, another local account, or a compromised
same-user process safe.

## Supported deployment

The supported shape is one user operating After Effects and ae-mcp on the same local machine.
Panel agents and configured external clients spawn Core over MCP stdio. Core calls the CEP host over
loopback HTTP; CEP reaches After Effects through maintained JSX or the local native AEGP transport.
The Platform Helper supplies OS credential-store and window-capture adapters.

Non-loopback or forwarded MCP/HTTP, remote AE hosts, shared daemons, second-user access,
multi-user/multi-tenant operation, and service accounts are unsupported. A configurable local URL
does not create a supported remote-server mode.

## Security promise: provider and API secret confidentiality

Provider/API secrets must not enter:

- tracked source, generated repository artifacts, fixtures, or test snapshots;
- ordinary configuration files, exported settings, Tool Library packages, or project files;
- logs, diagnostics, audit summaries, acceptance evidence, crash reports, or user-facing errors;
- command lines or process environments other than the selected provider process that requires
  the value; or
- an unselected backend, fallback route, or unrelated helper operation.

Runtime secrets remain behind the OS credential-store interface. Product state carries opaque
secret references, not secret values. Secret writes are verified, deletion is explicit, diagnostics
are redacted, and an unavailable secret store fails closed rather than falling back to plaintext.
Release and signing credentials remain confined to protected release environments.

This promise covers accidental disclosure by ae-mcp. It is not a promise to resist an administrator,
OS compromise, memory inspection, or hostile code already running as the trusted host user.

## Explicitly rejected security work

The product does not claim or plan defenses against:

- a second local OS user, another same-UID process, or a hostile process inside the AE/CEP tree;
- malicious configured MCP clients, malicious allowed model actions, or arbitrary JSX submitted by
  an admitted caller;
- endpoint discovery, token theft, PID reuse, process-ancestry spoofing, local denial of service,
  or other hostile-local-process attacks;
- remote authentication, pairing, connection codes, fingerprint confirmation, tenant isolation, or
  service-account authorization; or
- power-loss continuation, crash-resilient session continuation, cross-restart task resumption, or
  automatic redispatch after an interrupted operation.

Do not create release gates, acceptance requirements, or hardening Issues for these rejected goals.
Existing loopback, token, filesystem-mode, same-UID, endpoint, and AE-ancestry checks may remain
while they are cheap and do not obstruct the product. Their presence is an implementation detail,
not a supported security boundary. Remove or simplify one in a separate change only when it blocks
normal use or creates measured maintenance cost.

## Correctness and data integrity are retained

The following are not adversarial security claims and remain required:

- typed input validation, bounded paths and payloads, protocol compatibility, and structured errors;
- before/after state, idempotency, audit, postconditions, real Undo, and reconciliation of
  `POSSIBLY_SIDE_EFFECTING_FAILURE`;
- no blind retry after an uncertain write;
- atomic ordinary updates, deterministic rollback, and repair of a currently observed invalid
  installation when the supported recovery path is available; and
- approval, pause, and kill-switch controls that reduce operator mistakes.

These controls protect project correctness and normal operation. They do not sandbox a trusted MCP
caller. In particular, public `ae_exec` accepts full JSX source and therefore sets the authority
ceiling for the product.

## Release integrity is retained

Code signing, notarization, Authenticode, immutable release inputs, artifact manifests, protocol and
component compatibility, and exact release-candidate identity remain release requirements. They
support platform installation, reproducibility, and promotion of reviewed bytes. They must not be
expanded into a claim that the runtime resists another local user or hostile same-user code.

## Change trigger

Supporting remote access, a second user, shared-service operation, intentionally hostile clients, or
untrusted same-user processes requires an explicit product decision and a new threat model before
implementation. Until then, such work is out of scope rather than deferred security debt.

See `docs/platform/PLATFORM_HELPER_SECURITY.md` for credential and signing details,
`docs/RELEASE.md` for release integrity, and `docs/CAPABILITY_PACKAGE_WORKFLOW.md` for correctness
and real-AE evidence.
