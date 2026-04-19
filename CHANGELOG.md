# Changelog

## 2026-04-18

- Added a multiselect `...` tray action that opens a compact bottom-right selection panel for shared actions like forward/back, duplicate, lock, and delete.
- Fixed multiselect so clicking an already selected object deselects it, while dragging still moves the whole selected group.
- Fixed pan fling release velocity so pausing briefly after a drag no longer reuses stale movement speed and launches the viewport unnaturally.
- Scope board width/height draft edits to the currently selected board so switching selection does not apply the draft to a different board.
- Allow dropping multiple image files at once to create separate unlocked boards with a small placement offset for each imported image.
- Lower the minimum board dimension to 16 pixels while preserving aspect ratio in the board sizing helpers.
- Preserve card, deck, and board names exactly when duplicating objects instead of appending "Copy".
- Added a symmetric alpha-trim crop helper with test coverage for centered transparent-border trimming behavior.

## 2026-04-17

- Made dragging a deck onto a card move that card onto the bottom of the dragged deck, while direct card drops onto decks still land on top.
- Added a soft shadow around the bounded board grid surface so the 5000x5000 world area reads as a distinct play surface against the full-viewport backdrop.
- Reworked the DOM board background so the grid is clipped to the board surface with a separate full-viewport backdrop glow, and dropped native object tooltips that were interfering with board interactions.
- Smoothed steady-state board zooming by preparing cropped sprite-backed card and deck faces into dedicated image surfaces after load, which cuts repeated large sprite-sheet decode work out of the compositor hot path.
- Added a board input recorder plus Playwright zoom and recorded-input replay harnesses so zoom and pan jank can be reproduced and measured against real room interactions.
- Tightened board image preloading and DOM image layout for the HTML/CSS board renderer while preserving the card/deck/board selection and transform model.
- Raised prepared surface sizing for large image boards so unified cached surfaces stay crisp instead of downsampling big assets too aggressively.
- Added Google Maps-style pan momentum to the DOM board camera, then fixed the release/clamping math so background flings glide smoothly instead of snapping or dying on the first tick.
- Tightened resting and pickup shadows for boards, cards, and decks so object separation reads more crisply without the earlier diffuse blur.
- Made alpha-masked board selection outlines track live zoom updates continuously so they rerasterize during the gesture instead of snapping at the end.
- Made prepared image-surface prewarming yield to active interaction and memoized per-object board content so startup decode work and camera churn interfere less with pan and zoom.
- Switched prepared sprite-surface generation to prefer cached `ImageBitmap` crop-and-resize work before blob encoding, reducing the amount of main-thread canvas resizing in the image prep path.
- Suppressed native iOS Safari touch selection and loupe behavior inside the board canvas so dragging cards on mobile no longer triggers the system magnifier.
- Reduced mobile Safari zoom-out crash pressure by removing the giant transformed world-sized grid surface, lowering Safari image prep caps, and simplifying card rendering to only keep the visible side mounted on that path.
- Refined mobile touch gesture handoff so locked-object pinches zoom correctly and a second finger can pan during an active object drag without spuriously resetting into zoom.
- Kept selection quick actions attached to the selected object during live pan and zoom by wiring the overlay into the same imperative camera-update path as the board transform.

## 2026-04-16

- Fixed the WebGL `glDrawElements: Insufficient buffer size` warnings in large image-heavy rooms by tightening sprite texture cropping and separating movable pieces into their own Pixi render group.
- Rebuilt the board renderer as pure HTML/CSS, removing the PixiJS dependency while keeping board pan/zoom, selection, dragging, deck interactions, and image-backed surfaces working in the DOM.
- Reduced camera panning overhead by moving the board world with a single transform and debouncing persisted camera updates.
- Fixed deck card lift-out dragging, removed default board chrome from transparent image boards, and replaced image-board selection rendering with a cached canvas-generated alpha outline that behaves better across zoom levels and cropped assets.
- Moved card selection to CSS outlines, pushed regular selection rings fully outside cards and decks, and repositioned the rotate handle above the selected object without hover drift.

## 2026-04-15

- Added alpha-following Pixi outline selection chrome for image-backed boards, with higher-resolution generated masks to keep transparent edges crisp.
- Made card and deck selection outlines keep a consistent screen-pixel thickness while zooming the board.
- Made dragged boards raise to the front using the same lift-to-front behavior as other movable objects.

## 2026-04-13

- Let group selection mix boards with cards and decks, while still keeping boards out of deck drops.
- Let image files dropped onto the board import into the room and immediately create a board at the drop location, with drop-target and error feedback on the canvas.
- Made the room-image upload control accept Finder drag-and-drop reliably by treating file drags as valid drop targets during hover and blocking the browser's default file-drop navigation.
- Reworked board resizing into a Figma-style inspector section with direct width and height math-entry support while keeping board aspect ratios locked.

## 2026-04-12

- Replaced the bottom-right `Select` label with an icon-only selection-mode button.
- Added room-local image assets backed by separate Automerge documents, wired upload-first image controls into board/card editing flows, and taught Pixi to render stored blob-backed images correctly.
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
