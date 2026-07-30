# CommandSuite — agent context

Read **[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)** first. It is canonical for the branch
model, the DCO requirement, changesets, and how tests are expected to read here.

Two things worth knowing before your first commit, because they are the ones most often missed:

- **Branch from `develop`, never from `main`.** `main` is protected and merges only through a
  reviewed pull request. (The fork-and-PR-to-`main` workflow in CONTRIBUTING is for outside
  contributors.)
- **Assert completeness, not presence.** Ask whether your test would pass against a version that
  returns *some* of the right answer.

Every commit needs a `Signed-off-by` trailer (DCO). Commit signing is configured but currently
fails in this environment — see CONTRIBUTING; disable GPG signing, keep the trailer.
