# Multiselect UX Spec

## Goal

Support selecting multiple board objects and moving them together without overloading the normal play flow.

This must work well on:

- mobile touch devices
- desktop mouse/trackpad

It must support multiselect for:

- cards
- decks
- mixed groups of cards and decks

Boards may be added later, but they are not required for the first release.

## Design Principles

- Single-select remains the default behavior.
- Multiselect is an explicit board mode.
- Mode entry and exit should live in stable screen chrome, not object-local affordances.
- The board remains the primary interaction surface.
- Mobile and desktop share the same core model.
- Lasso is an explicit tool, not an always-on gesture.

## Core Model

There are two selection states:

1. Normal selection mode
2. Group selection mode

Normal selection mode is the default board state.

Group selection mode is a distinct interaction mode for composing and moving a set of objects.

While group selection mode is active:

- selection is a set of object ids
- one object may be tracked as the primary object for internal state
- taps toggle objects in or out of the set
- dragging a selected object moves the whole group
- the bottom-right dock switches from creation controls to selection controls

## Entry Affordance

### Primary entrypoint

The bottom-right dock should expose a `Select` control.

This control should be available even when nothing is currently selected, so lasso-based selection can begin from an empty board state.

Entering selection mode works like this:

- if one object is already selected, selection mode starts seeded with that object
- if nothing is selected, selection mode starts empty

### Why this affordance

- It makes multiselect feel like a board mode, not an action on one object.
- It supports lasso from zero selection.
- It avoids overloading object quick actions.
- It is visible and learnable on mobile and desktop.

## Bottom-Right Dock Behavior

### Normal mode

In the default state, the bottom-right dock contains creation and selection entry controls.

Exact visual composition can be refined later, but conceptually it contains:

- `+` for add/create
- `Select` for entering group selection mode

### Group selection mode

When group selection mode is active, the dock stops showing the normal add/create affordance and becomes a selection tray instead.

The selection tray should show:

- selection count, e.g. `3 selected`
- `Lasso`
- `×` to exit selection mode

There is no separate `Done` action.

The `×` action is the explicit exit from group selection mode.

Whether exiting leaves one object selected or clears selection entirely is intentionally undecided for now.

## Selection Behavior

### Normal selection mode

- Tap/click an object to select it.
- Tap/click empty board space to clear selection.
- Quick actions apply to the selected object only.

### Group selection mode

- Tap/click an unselected object to add it to the selection.
- Tap/click a selected object to remove it from the selection.
- Dragging a selected object moves the whole group.
- Tap/click on empty board space does not exit group selection mode.

If the selection becomes empty, group selection mode exits automatically.

## Drag Behavior

### Group move

Dragging any selected object moves the entire selected group.

Movement rules:

- the pressed object acts as the drag anchor
- all selected objects preserve their relative offsets
- all selected objects preserve their current rotations
- z-order within the selected group is preserved

### Commit behavior

On release, all object transforms are committed together.

## Lasso Tool

### Entry

Lasso is entered explicitly from the selection tray by tapping `Lasso`.

### Behavior

While lasso is active:

- the next drag draws a freeform closed shape on the board
- object dragging is disabled for that pointer sequence
- viewport pan and pinch should not take over that pointer sequence

On release:

- every object inside the lasso is added to the current selection
- the app remains in group selection mode
- lasso mode ends

### First version inclusion rule

For the first version, an object counts as inside the lasso when its center point lies inside the lasso polygon.

This is preferred over bounding-box overlap for the first release because it is easier to reason about and avoids awkward edge cases with rotated objects.

## Deck-Specific Behavior While Group Selection Is Active

Group selection mode changes how decks behave.

While group selection mode is active:

- tapping a deck toggles its membership in the selection set
- dragging a selected deck moves the whole group
- deck pull-top-card behavior is disabled
- deck long-press behavior is disabled
- grouped drop-into-deck is disabled
- grouped deck-merge is disabled

This is necessary to avoid conflicting semantics between manipulating one deck and manipulating the selected group.

## Drop Behavior

### First version scope

In the first version of multiselect:

- grouped drag only moves objects on the plane
- grouped drop-into-deck is not supported
- grouped deck-merge is not supported

If a grouped drag ends over a deck, the group should remain on the plane at the dropped positions.

## Rotation Behavior

### First version scope

Group rotation is out of scope for the first version.

While group selection mode is active:

- individual rotate handles are hidden or inactive
- rotation applies only in normal single-selection mode

## Quick Actions

Object quick actions are not the entrypoint for multiselect.

In normal selection mode:

- quick actions remain lightweight and object-specific

In group selection mode:

- object-local quick actions should be hidden

This keeps mode-level controls in one stable place and avoids competing overlays.

## Mobile Behavior

Mobile follows the same core model as desktop.

Key rules:

- `Select` is the entrypoint
- `Lasso` is explicit
- taps toggle membership while group selection mode is active
- dragging any selected object moves the group
- empty-board taps do not implicitly destroy the mode

## Desktop Behavior

Desktop follows the same main model as mobile.

Possible future accelerators:

- `Shift`-click to toggle membership
- marquee or box-select as an additional selection tool

These are secondary and should not replace the primary mode-based flow.

## Visual Design Notes

Selected objects in group mode should be easy to parse at a glance.

Recommended treatment:

- bright outline around each selected object
- optional stronger accent on the primary object
- lasso path clearly visible while drawing
- selection tray visually distinct from the normal add/create dock

Avoid noisy per-object controls while group selection mode is active.

## Interaction Examples

### Example: seed from a selected card

1. Tap a card.
2. Tap `Select` in the bottom-right dock.
3. Group selection mode starts with that card selected.
4. Tap two more cards.
5. Drag any selected card.
6. The whole group moves together.

### Example: lasso from zero selection

1. Tap `Select` in the bottom-right dock.
2. Tap `Lasso`.
3. Draw around several cards and decks.
4. Release.
5. Everything inside the lasso is added to the selection.

### Example: exit selection mode

1. While group selection mode is active, tap `×` in the selection tray.
2. The app exits group selection mode.
3. Whether one object remains selected or everything is cleared is intentionally left open for now.

## Non-Goals For First Version

- group rotation
- grouped drop into deck
- grouped merge into deck
- object-local multiselect entry
- hidden long-press multiselect entry
- always-on lasso gesture
- boards as a required part of v1 multiselect support

## Implementation Guidance

The underlying selection state should support:

- a set of selected object ids
- an optional primary selected object id
- a mode flag for normal vs group selection mode
- a temporary lasso tool state while the lasso gesture is active

Board interaction code should treat group selection as a distinct input mode, especially for deck handling and drag behavior.

## Open Questions

- On `×`, should the app keep one object selected or clear selection entirely?
- Should the primary object always become the most recently tapped selected object?
- Should boards join multiselect in the first implementation, or later?
- Should `Select` always be visible in the bottom-right dock, or only when editing is possible?

## Recommended First Release

Ship the minimal coherent version:

- explicit `Select` entry in the bottom-right dock
- dock transforms into a selection tray while active
- selection tray shows count, `Lasso`, and `×`
- mixed card/deck multiselect support
- tap to add/remove
- drag any selected object to move the group
- explicit lasso add-to-selection flow
- no group rotate
- no grouped deck drop or merge

This gives the app a strong, learnable multiselect model that matches the rest of the UI better than the earlier object-local design.
