Follow `docs/CAPABILITY_PACKAGE_WORKFLOW.md`. The linked Issue is the source of truth for a capability package's scope and acceptance matrix; do not copy it here.

Complete **Common** for every PR. For an AE-dependent capability package, also complete **Native package evidence**. For any other PR, delete that section or write one `N/A` line with the reason and observable acceptance check; do not fill field-by-field `N/A` values.

## Common

- Change type: native capability package / isolated fix / docs / infrastructure
- Issue or package Issue:
- User-visible outcome:
- Scope and explicit non-goals:

Commands and results:

```text

```

Review findings and disposition (blocker / follow-up / out of scope):

## Native package evidence (conditional)

- Deviation from the frozen Issue: none / describe and link the decision
- Frozen candidate SHA:
- T3 and required CI status on that SHA:
- All relevant Core / CEP / native / protocol identities match: yes / no
- Redacted T5 real-AE evidence link or summary:
- Post-freeze SHA replacement and reason: none / describe

After merge, record T6, child-Issue closure, and efficiency counters once in the package completion comment using `docs/templates/capability-package-completion.md`.
