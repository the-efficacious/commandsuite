# csuite-cli

## 0.0.1

### Patch Changes

- f760db7: Fix a transcript-reader race where a drain already in flight when `close()`
  landed could still emit activity events for lines appended after close.
  - csuite-core@0.0.1
  - csuite-sdk@0.0.1
  - csuite-server@0.0.1
