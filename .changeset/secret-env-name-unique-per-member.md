---
'csuite': patch
'csuite-cli': patch
'csuite-core': patch
'csuite-sdk': patch
'csuite-server': patch
'csuite-web-host': patch
'csuite-web-ui': patch
---

Allow two secrets to target the same environment variable for different members.

Registering a second secret with an env name already in use returned **409 Conflict**,
because `env_name` carried a global unique index. The rationale in the source was correct —
*"a member's resolved env map can never carry two values for one variable"* — but the
constraint enforcing it was far stronger than the invariant it protected.

The result is that the per-agent pattern the product is built around was impossible:
`cora-github-token` targeting `GITHUB_TOKEN` permanently blocked `rune-github-token`
targeting `GITHUB_TOKEN`, even though no member is ever bound to both. Provisioning a
second agent with its own credentials failed on the second secret.

The invariant is now enforced where it can first be violated:

- **`bind()`** refuses when the member already resolves that variable from another secret.
  This is the real check — binding is the first moment a targeted secret reaches anyone.
- **`create()`/`update()`** additionally refuse for `allMembers` secrets, which reach
  everyone without a binding and so can collide before any bind happens.
- **`update()`** re-checks against the audience the secret will have *after* the patch, so
  widening to all-members or repointing at a new variable can't slip a collision through.

The global unique index is dropped in the schema DDL (`DROP INDEX IF EXISTS`), which
migrates existing databases and fresh ones by the same path. Without the drop, an existing
deployment would keep rejecting the second binding with a raw SQLite constraint error
instead of a mapped one.

`POST /secrets/:slug/bindings` now maps `SecretsError` through `mapSecretsError`, so the
new conflict surfaces as **409** rather than an unhandled **500**.

**Behaviour that changed, deliberately:** two previously-passing tests asserted the old
global uniqueness, and both were rewritten rather than deleted — one now asserts that a
second secret on the same variable is *accepted*, and the update test asserts a conflict
only once two secrets actually share a member. The store's header docblock stated the old
rule and has been corrected; a comment that contradicts the code is a defect in its own
right.

Released as a patch: it removes a restriction rather than adding or breaking one, and no
caller that previously succeeded now fails.
