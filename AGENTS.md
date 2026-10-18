# Divvy UI preferences

Prefer floating white cards over expanding expense rows for secondary details, editing, and confirmation flows. Expense history, Move to Pending, custom allocation, and Split Transaction should use this pattern.

Follow the existing native modal dialog styling: rounded white card, soft shadow, dimmed and blurred backdrop, clear heading, and separate footer actions. Support a close button, Escape, and clicking outside. Restore focus to the opener. Dismiss unfinished form input without saving it; prevent dismissal while an explicit save is running.

Keep primary expense fields compact in the row. Keep the orange edited indicator close beneath the item with a small readable gap, left-aligned with the date column.

For split controls, selected member backgrounds match the exact member color; selected equal is dark gray and custom is purple. Icons, letters, and underlines turn white. Hover must preserve selected colors.

Use four shared typography roles: Heading 1 (24px, semibold), Heading 2 (18px, semibold), Body 1 (14px), and Body 2 (12px). Body text uses normal weight, with semibold emphasis. Duplicate warnings and review notes use Body 1; secondary metadata uses Body 2. Preserve 16px touch-input sizing where needed for mobile usability. Reuse central role settings instead of adding one-off sizes.

When one or more expenses are selected, bulk editing uses a floating toolbar fixed near the viewport bottom and aligned to the ledger width. Preserve access to the last rows and allow the toolbar itself to scroll if its controls exceed the available height.

Typography settings live in `src/index.css`. Prefer `text-heading1`, `text-heading2`, `text-body1`, and `text-body2` for new UI. Existing size utilities are aliases to those roles for compatibility.
