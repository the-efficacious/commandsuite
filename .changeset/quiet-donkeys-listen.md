---
'csuite-web-ui': patch
---

Hold Home, Inbox, Members, Tools and Notifications to a readable
measure, so panel content stops stretching to the window on a wide
display.

The runner-environment views took a measure when they landed; every
other panel still ran edge to edge, which on a wide monitor left stat
tiles a third of a screen apart and help lines running past 1600px.

The constraint lands on the scroll container's children rather than on
a wrapper, because the scroller owns the scrollbar and the page
background. It is opt-in per panel — the nav rail uses the same
scroller and its items are meant to fill it.

Two widths, chosen by what the view is: an INDEX (1080px) earns its
width from rows that carry data to the right edge; a RECORD (780px) is
one entity's fields, where the widest control is a name. Tool-source
and notification detail take the record measure.

`MemberProfile` is deliberately excluded. Its header sits outside the
scroller and its tab content is a fit-content card, so centring the
children strands the card mid-window instead of aligning it to a
column. It needs a real wrapper element, which is a structural change
rather than this one.
