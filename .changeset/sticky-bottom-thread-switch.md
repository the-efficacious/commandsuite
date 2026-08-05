---
'csuite-web-ui': patch
---

Fix a thread switch opening the new chat partway up rather than at its
newest message.

`Transcript` re-renders on a thread switch, it does not remount, so every
ref inside `useStickyBottom` survived the switch — including the one
recording that the viewer had scrolled up. Follow stayed disengaged into
the next thread, and the browser preserves `scrollTop` across a children
swap, so the new thread opened at the offset the previous one left
behind: as far in as the previous chat was long.

`useStickyBottom` now takes a `resetKey`, mirroring `useWindowedList`,
and `Transcript` passes `threadKey`. "The user chose to read history" is
a fact about the list they were reading and no longer outlives it.
