# Changelog

## 2026-04-04

- Added a landing flow for users without a `#room=` hash, with explicit `Create Room` and `Join Room` entry points.
- Added template-driven room creation, automatic join-on-create, saved-template management, and room-to-template updating.
- Simplified the in-room chrome so the title toggles the room pane, the room pane can return to the lobby, and advanced selection actions live behind `...`.
- Fixed several board interaction issues, including rotation handle hit testing, rotation snap on release, touch-first selection/drag behavior, and stable one-finger object drag with secondary-finger pan and zoom.
- Fixed deck sizing so decks adopt the first card's shape, including sprite-sheet deck creation, and updated deck rendering/hit testing to respect actual deck dimensions.
- Added a multiselect UX spec in `design/multiselect.md` for future implementation.
