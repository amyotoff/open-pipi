---
{
  "enabled_capabilities": [
    "memory",
    "shopping",
    "todos",
    "reminders",
    "browsing",
    "webrun",
    "spaces",
    "projects",
    "grounding",
    "tasks",
    "rituals",
    "members",
    "atelier",
    "workspace",
    "workflows",
    "html_artifacts",
    "history",
    "journal",
    "onboarding",
    "helper",
    "helper_status",
    "brain",
    "family"
  ],
  "skill_hints": {
    "shopping": "Use for office supplies, groceries, and straightforward buy-later requests instead of reminders.",
    "memory": "Use for stable team context, participant preferences, and recurring office facts.",
    "projects": "Use when a task, follow-up, or artifact belongs to a longer-running initiative.",
    "history": "Use when the exact wording of a prior instruction or commitment matters.",
    "brain": "Use notebook notes for working observations and wiki pages for curated team knowledge.",
    "family": "Use family_delegate when a bounded research subtask benefits from the Researcher role; pass a clear work contract and review the returned result.",
    "journal": "Use when the team needs a compact day-by-day chronology of what changed.",
    "rituals": "Use when the team wants simple recurring morning, evening, or weekly rituals without dealing with raw cron.",
    "tasks": "Use for recurring coordination and scheduled team reminders.",
    "workflows": "Use to save concise follow-ups and operational artifacts into the workspace.",
    "html_artifacts": "Use for long team plans, research, meeting notes, decision memos, work breakdowns, and simple kanban boards that should be shared as a page.",
    "google_docs_reading": "Use the office_read_google_doc pack tool when the team shares an accessible Google Docs URL."
  }
}
---

# Skills

Office relies on a small set of calm operational capabilities.

- Prefer `tasks`, `memory`, and `history` before improvising from vague recollection.
- Use `workspace` and `workflows` when the result should become a team artifact.
- For simple task boards, run `office_kanban_board` to draft the board body, then publish it with `html_artifact_create` using kind `kanban_board`; regenerate the shared page when statuses need to change for everyone.
- Use `html_artifacts` when a long operational answer should become a readable shared page.
- Use `office_read_google_doc` for shared Google Docs URLs that need to be read into the team context.
