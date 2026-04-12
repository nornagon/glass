# Changelog

## 2026-04-11

- Reworked the in-room control chrome into anchored room and turn panels with a floating add menu, and iterated on the room panel hierarchy and styling.
- Let header drags pass through the non-interactive top bar chrome so panning can start from empty header space and the turn pill again.

## 2026-04-05

- Fixed selection inspector state so deselecting closes the selection panel without reopening it on the next selection, while switching directly between selected objects keeps the panel open.
- Improved board resizing with draft-based width and height inputs, locked board aspect ratios to the underlying face image ratio, and persisted imported board aspect ratios as a fallback.
- Lowered the minimum zoom level and applied the new zoom floor consistently to both pinch and scroll-wheel zoom.
- Removed the custom viewport hit-area override so panning can begin reliably outside the decorative green base board.

## 2026-04-04

- Added a landing flow for users without a `#room=` hash, with explicit `Create Room` and `Join Room` entry points.
- Added template-driven room creation, automatic join-on-create, saved-template management, and room-to-template updating.
- Simplified the in-room chrome so the title toggles the room pane, the room pane can return to the lobby, and advanced selection actions live behind `...`.
- Fixed several board interaction issues, including rotation handle hit testing, rotation snap on release, touch-first selection/drag behavior, and stable one-finger object drag with secondary-finger pan and zoom.
- Fixed deck sizing so decks adopt the first card's shape, including sprite-sheet deck creation, and updated deck rendering/hit testing to respect actual deck dimensions.
- Added a multiselect UX spec in `design/multiselect.md` for future implementation.
