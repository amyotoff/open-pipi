# Jeeves Pack Tools

These are pack-local product actions for the PA Jeeves experience.

- `jeeves_brief_note`
  Generate a compact personal brief for the current space.

- `jeeves_focus_plan`
  Turn current context into a short list of the most useful next actions.

- `jeeves_review_note`
  Produce a short end-of-day review for the current space.

At the moment the Telegram product layer uses these concepts directly through `/brief`, `/focus`, and `/review`. The scripts are already packaged with Jeeves so the next pass can expose them as first-class pack tools without changing the pack format.
