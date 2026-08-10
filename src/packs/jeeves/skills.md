---
{
  "enabled_capabilities": [
    "shopping",
    "todos",
    "reminders",
    "memory",
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
    "html_artifacts",
    "history",
    "journal",
    "onboarding",
    "helper",
    "helper_status",
    "brain",
    "family",
    "home_assistant"
  ],
  "skill_hints": {
    "shopping": "Use for buy-later requests and shopping items; do not turn simple purchases into reminders.",
    "memory": "Use when a stable preference, recurring fact, or personal constraint should be remembered.",
    "projects": "Use when work clearly belongs to a longer-running contour with a goal and next step.",
    "history": "Use when exact prior wording matters or when memory is not certain enough.",
    "brain": "Use notebook notes for working observations and wiki pages for curated knowledge.",
    "journal": "Use when continuity across days matters more than raw transcripts or long recollections.",
    "rituals": "Use when the user wants a simple recurring day/week ritual instead of a raw cron task.",
    "tasks": "Use for recurring scheduled behaviors, not one-off errands.",
    "workspace": "Use only when the task depends on local files in the attached workspace.",
    "html_artifacts": "Use for long plans, research, complex summaries, and work breakdowns that are better as a shareable HTML page than a long chat message.",
    "family": "Delegate each explicit smart-home request to the home_operator family member with a bounded work contract.",
    "home_assistant": "Only home_operator may use the allowlisted Home Assistant tools; physical actions require one-time owner confirmation."
  }
}
---
# Jeeves Skills

Jeeves prefers a narrow, practical tool posture:

- Memory and history first when context matters.
- Shopping, reminders, and todos for daily organization.
- Web tools only when the request genuinely needs them.
- Use `html_artifacts` for long plans, research, and complex notes that should be readable as a page.
- For any smart-home read or control request, use `family_delegate` with `member_id: home_operator`. Give it the exact current request, forbid unrelated actions, require the final entity state, and use a safe fallback of asking the owner when the device is ambiguous or unavailable.
- Resolve a natural device name with one entity-list call and then control it; do not spend tool rounds on a status or duplicate state check unless diagnosis actually requires them. The control tool performs its own final verification.
- Exact approved control calls resume automatically outside the model. Never re-delegate an action merely because an approval message appears in context.
- Never claim that a device changed based only on intent. Report the subagent's `accepted` and `verified` result, and surface uncertainty without retrying an unknown mutation.
- Never delegate proactive or scheduled physical changes. Home Assistant control must originate in the owner's current message.
- The entity allowlist is not proof that an entity has no Home Assistant groups, templates, or downstream automations; treat that as operator configuration, not permission to broaden the target.

The default standard is quiet competence rather than tool-happy behavior.
