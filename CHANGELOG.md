# Changelog

## 2026-04-12

- Replaced the bottom-right `Select` label with an icon-only selection-mode button.
- Fixed viewport clamp sizing so fully zoomed-out boards can still pan horizontally on wide screens.
- Clarified in `AGENTS.md` that commits must run `date` before updating `CHANGELOG.md`.
- Made `Escape` exit group selection mode and clear the current single selection.
- Added `Shift`-click promotion from a single selected card or deck into group selection.
- Fixed ephemeral drag-end messages so remote clients keep the final snapped move or rotation preview until the persisted room transform arrives.
- Restored the add button's open/close rotation animation and fixed the add-menu scrim layering so the menu stays above the backdrop.
- Reworked the multiselect design around a bottom-right `Select` mode, then implemented the first pass with a selection tray, explicit lasso tool, grouped drag for cards and decks, and multi-object ephemeral drag previews.
- Persisted joined player IDs in `localStorage` so reopening the browser keeps the same player identity for each room.
- Added player removal from the turn panel, including a self-serve leave action that clears the local joined-player record.
- Updated the room model and tests so removing a player also updates turn ownership and card visibility lists consistently.

## 2026-04-11

- Ignored Playwright capture output under `output/playwright/` and removed those generated artifacts from version control.
- Added a more three-dimensional flip animation for cards so face changes now animate with lift and a card-turn motion instead of swapping instantly.
- Fixed remote rotation previews so the snapped release angle shows up immediately for connected clients instead of waiting for the persisted Automerge change.
- Added Automerge ephemeral drag previews so connected clients see in-flight object movement and rotation in real time without persisting every pointer move to room history.
- Reworked the in-room control chrome into anchored room and turn panels with a floating add menu, and iterated on the room panel hierarchy and styling.
- Let header drags pass through the non-interactive top bar chrome so panning can start from empty header space and the turn pill again.
- Simplified the header and turn panel with a single expanding turn pill, inline room/player name editing, explicit observer join affordances, and denser player rows.

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
