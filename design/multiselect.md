# Multiselect UX Spec

## Goal

Support selecting multiple board objects and moving them together without disrupting the app's default play-first interaction model.

This must work well on:

- mobile touch devices
- desktop mouse/trackpad

It must support multiselect for:

- cards
- decks
- mixed groups of cards and decks

## Design Principles

- Single-select remains the default behavior.
- Multiselect is explicit, not gesture-hidden.
- The primary interaction surface is the board, not a side panel.
- Mobile and desktop should share the same core model.
- Common play actions stay lightweight and local to the selected objects.
- Advanced editing stays secondary.

## Core Model

There are two selection states:

1. Single selection
2. Group selection

Single selection is the normal board state.

Group selection is an explicit mode entered from the selected object's floating quick actions.

While in group selection:

- the selection is a set of object ids
- one selected object is the primary object
- tapping objects toggles them in or out of the set
- dragging any selected object moves the entire group

## Entry Affordance

### Primary entrypoint

When a card or deck is selected, its floating quick actions should include a `+` action.

Examples:

- card: `Flip`, `+`, `...`
- deck: `Flip`, `Draw`, `Shuffle`, `+`, `...`

Tapping `+` enters group selection mode and seeds the selection set with the currently selected object.

### Why this affordance

- It is board-local.
- It is visible and learnable.
- It works on mobile and desktop.
- It does not conflict with existing deck gestures.
- It avoids relying on modifier keys or long-press discovery.

### Optional desktop accelerator

Desktop may also support `Shift`-click to add/remove an object from the current selection, but this is a secondary accelerator only. The primary model must remain usable without a keyboard.

## Group Selection UI

When group selection is active:

- every selected object gets a strong, consistent highlight
- the primary object may receive a slightly stronger accent treatment
- a compact floating group bar appears on the board

The group bar should show:

- selection count, e.g. `3 selected`
- `Done`
- `Clear`

The group bar should be small, unobtrusive, and placed near the current selection or in another stable board-local location.

## Selection Behavior

### Single selection mode

- Tap/click an object to select it.
- Tap/click empty board space to clear selection.
- Quick actions apply to the selected object only.

### Group selection mode

- Tap/click an unselected object to add it to the selection.
- Tap/click a selected object to remove it from the selection.
- If the primary object is removed and the set is still non-empty, another object becomes primary.
- Tap/click on empty board space does not immediately destroy the group.

This is intentional. On mobile, accidental empty-board taps are common. Destructive exit should be explicit.

### Exiting group selection

- `Done` exits group selection and returns to single selection, keeping the primary object selected.
- `Clear` clears the set and exits group selection.
- If the selected set becomes empty through toggling, group selection exits automatically.

## Drag Behavior

### Group move

Dragging any selected object moves the entire selected group.

Movement rules:

- the pressed object acts as the drag anchor
- all selected objects preserve their relative offsets
- all selected objects preserve their current rotations
- z-order within the selected group is preserved

### Visual behavior during drag

- the whole group should visibly move together
- the selection highlight remains visible during drag

### Commit behavior

On release, all object transforms are committed together.

## Deck-Specific Behavior While Group Selection Is Active

Group selection changes how decks behave.

While group selection is active:

- tapping a deck toggles its membership in the selection set
- dragging a selected deck moves the whole group
- deck-specific pull-top-card behavior is disabled
- deck long-press behavior is disabled

This avoids conflicting semantics between "manipulate this deck" and "manipulate the selected group."

## Drop Behavior

### First version scope

In the first version of multiselect:

- grouped drag only moves objects on the plane
- grouped drop-into-deck is not supported
- grouped deck-merge is not supported

If a grouped drag ends over a deck, the group should simply remain on the plane at the dropped positions.

This keeps the first release predictable and avoids ambiguous results for mixed groups.

## Rotation Behavior

### First version scope

Group rotation is out of scope for the first version.

While group selection is active:

- individual rotate handles are hidden or inactive
- rotation applies only in single selection mode

This keeps the interaction model simple and prevents confusion around shared pivot points.

## Panel and Advanced Actions

The advanced actions panel should not be required for multiselect.

Multiselect is a board interaction, so all core affordances should live on the board:

- enter via `+`
- manage selection via taps
- move via drag
- exit via group bar controls

The panel may later expose advanced group actions, but it should not be the entrypoint.

## Mobile Behavior

Mobile must follow the same core model as desktop.

Key rules:

- `+` is the entrypoint
- taps toggle membership while group selection is active
- dragging any selected object moves the group
- empty-board taps do not implicitly destroy the selection set

This keeps the mobile model deliberate and reduces accidental mode loss.

## Desktop Behavior

Desktop follows the same main model as mobile.

Optional enhancements:

- `Shift`-click toggles membership
- future marquee selection may be added later

These are accelerators, not the primary UX.

## Visual Design Notes

Selected objects in group mode should be easy to parse at a glance.

Recommended treatment:

- bright outline around each selected object
- stronger accent on the primary object
- optional subtle badge or handle indicating grouped state

Avoid noisy per-object controls while group mode is active. The group bar should carry the mode-level actions.

## Interaction Examples

### Example: move three cards

1. Tap a card.
2. Tap `+`.
3. Tap two more cards.
4. Drag any selected card.
5. The whole group moves together.
6. Tap `Done` to return to single selection.

### Example: move two decks

1. Tap a deck.
2. Tap `+`.
3. Tap another deck.
4. Drag either selected deck.
5. Both decks move together.

### Example: move a mixed group

1. Tap a card.
2. Tap `+`.
3. Tap a deck.
4. Tap another card.
5. Drag any selected object.
6. All selected objects move together as one group.

## Non-Goals For First Version

- group rotation
- grouped drop into deck
- grouped merge into deck
- multiselect-only inspector workflows
- hidden long-press multiselect entry
- keyboard-only interaction model

## Implementation Guidance

The underlying selection state should support:

- a set of selected object ids
- a primary selected object id
- a mode flag for single vs group selection

Board interaction code should treat group selection as a distinct input mode, especially for deck handling, so deck pull/long-press behavior does not interfere with grouped drag.

## Open Questions

- Should `Flip` remain object-only while group selection is active, or should a future group action bar support batch actions?
- Should the primary object always be the most recently tapped object?
- Should there be a future marquee-select affordance for desktop?

## Recommended First Release

Ship the minimal coherent version:

- explicit `+` entrypoint on selected cards and decks
- mixed-object multiselect support
- board-local group bar with `Done` and `Clear`
- tap to add/remove
- drag any selected object to move the group
- no group rotate
- no grouped stacking/merge semantics

This gives the app a strong, learnable multiselect model without overloading the existing board interaction system.
