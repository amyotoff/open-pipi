# Structured state tool examples

## Current state

The runtime stores validated JSON under `state/<id>.json`. These examples are patch_json
arguments for wiki_state_update (current space) or wiki_state_save (shared, confirmed).
They are not Markdown pages to submit to update_wiki_page.

Create id `website` with expected_revision 0 and this patch_json:

```json
{
  "kind": "project",
  "title": "Website",
  "aliases": ["website"],
  "set_fields": {
    "phase": {
      "value": null,
      "status": "unknown",
      "observed_at": null,
      "source": null
    }
  }
}
```

Read with wiki_state_read(id: "website", origin: "space"). For an update, pass the
returned revision and only the changed fields. Known fields require an evidenced value,
a valid UTC ISO observed_at, and a source reference. Runtime timestamps record the write;
they do not substitute for observation time. Use separate requested and observed fields.

Create a named shopping list, id `party-supplies`, with expected_revision 0:

```json
{
  "kind": "shopping",
  "title": "Party supplies",
  "upsert_items": [
    {"id": "milk", "text": "Milk", "status": "pending", "quantity": "2 bottles"}
  ]
}
```

After reading its current revision, mark the item done with this patch:

```json
{
  "upsert_items": [
    {"id": "milk", "text": "Milk", "status": "done", "quantity": "2 bottles"}
  ]
}
```

The default todo/shopping lists are native states `todos` and `shopping`; modify them
with todos_* and shopping_* instead of creating a second copy. A reflection about why
shopping or calling a plumber is difficult belongs in an article, not in this list.
