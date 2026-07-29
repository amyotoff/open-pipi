# Addons, and how to write a subagent

An **addon** is a capability the runtime does not need. It ships in the repo, costs nothing until
someone turns it on, and can be removed without anything else noticing.

A **subagent** is a delegate: an agent the orchestrator hands a job to and cannot supervise while it
runs. It gets a task contract going in and returns a result contract coming out.

The voice-calls addon is both, which is why it is the worked example here. Everything below is real
code you can read: [`src/addons/voice-calls/`](../src/addons/voice-calls/) and
[`src/skills/phone.skill.ts`](../src/skills/phone.skill.ts).

---

## Part 1 — What makes something an addon

Three gates, and all three must open before a single line of addon code runs:

| Gate | Where it lives | Closed by default? |
| --- | --- | --- |
| The pack must enable the capability | `enabled_capabilities` in the pack's `agent.md` | Yes — no built-in pack lists `phone` |
| The provider must be configured | environment variables | Yes — no defaults |
| The owner must approve the action | `toolMeta.approval: 'explicit'` | Yes — per call |

None of these required a change to Core. That is the test of whether something is genuinely an
addon: if wiring it up meant editing the gateway, the router, or the agent loop, it is a feature
wearing an addon's clothes.

### Cost nothing when switched off

The voice addon has **no dependency entry at all**. Its SDK is loaded through a variable specifier
so that TypeScript does not resolve it either:

```ts
const moduleName = 'retell-sdk';
const imported: any = await import(moduleName);
```

An install that never makes a phone call does not carry a telephony SDK and does not fail to
typecheck for lacking one. Anyone turning calling on runs `pnpm add retell-sdk` themselves.

The trade is real and worth naming: you lose the SDK's types. For a module this thin — create a
call, poll for the result — that is a fair price for not taxing every other install.

### Register lazily

```ts
registerRetellProvider();          // called on first use, not at boot
const provider = getVoiceProvider();
```

Registering at import time means an unconfigured install still pays to load the module. Registering
on first use means it is only touched by someone who actually asked for it.

---

## Part 2 — What makes something a subagent

A subagent is not "an LLM call inside a tool". The distinguishing property is **you cannot watch
it**. A phone call happens at conversational speed with a stranger on the line; by the time the
orchestrator could react, the delegate has already answered.

That single constraint produces the whole design.

### The task contract: say everything up front

You get one chance to brief the delegate. [`CallTaskPayload`](../src/addons/voice-calls/types.ts)
has four permission fields, in two pairs:

| Field | Question it answers |
| --- | --- |
| `allowed_actions` | What may it do? |
| `decision_rights` | How far may it go on its own — budgets, ranges, fees? |
| `forbidden_actions` | What must it never do? |
| `hard_blockers` | Which lines hold regardless of how the conversation goes? |

**Both pairs are load-bearing.** A delegate given only permissions and no limits will be asked
something nobody anticipated, and it will improvise. Improvising on someone's behalf is how
commitments get made that nobody authorized.

`fallbacks` matters for the same reason, which is why the skill *refuses to place a call without
one*:

```ts
if (fallbacks.length === 0) {
    return '[TOOL_RESULT] Give at least one fallback — what should the agent do if the goal turns out to be impossible?';
}
```

A caller who has not thought about failure is exactly the caller whose call goes wrong.

### Guardrails the caller cannot remove

Some rules are not defaults. In
[`prompt-builder.ts`](../src/addons/voice-calls/prompt-builder.ts) the global guardrails are
appended **after** the caller's own restrictions, so supplying `forbidden_actions` adds to them and
never replaces them:

```ts
forbidden_actions: bullets([...payload.forbidden_actions, guardrails.forbidden]),
```

There is a test for exactly this, because it is the kind of thing a later refactor quietly breaks.

### The result contract: structure, not prose

The delegate returns [`CallResultContract`](../src/addons/voice-calls/types.ts) — not a transcript.
A transcript makes the orchestrator read a conversation it did not have and draw its own
conclusions, which is a second place for the answer to be wrong.

Two details worth copying:

**Normalise the vocabulary.** A booking says `booked`, a relay says `delivered`. Callers branching
on the result should not have to know which word this task type happens to use, so both become
`completed`.

**Report uncertainty honestly.** When only a summary came back and no structured fields, the
extractor says so and lowers `confidence` rather than inventing structure:

```ts
facts_collected: {},
confidence: successful ? 0.7 : 0.3,
```

A subagent that always sounds certain is worse than one that admits when it is guessing.

### Distinguish "did not work" from "cannot tell"

A normal hangup with nothing extracted is `partial`, **not** `failed`:

```ts
if (reason.includes('hangup') || reason.includes('transfer')) return 'partial';
```

The conversation did happen. Calling it a failure sends someone to redial a call that already went
through — and the person on the other end gets phoned twice about the same thing.

---

## Part 3 — Turning voice calls on

### 1. Install the SDK

```bash
pnpm add retell-sdk
```

### 2. Configure a provider

```dotenv
RETELL_API_KEY=
RETELL_AGENT_ID=
RETELL_FROM_NUMBER=+31000000000
```

You need a Retell account with one outbound agent, and a phone number — Retell can supply one, or
you can bring your own carrier over SIP. The agent's prompt lives in Retell's dashboard and should
reference the variables the addon injects: `{{goal}}`, `{{contact_name}}`, `{{must_collect}}`,
`{{allowed_actions}}`, `{{forbidden_actions}}`, `{{fallback}}`, `{{language_directive}}`,
`{{result_contract}}`.

### 3. Enable the capability in a pack

In your pack's `agent.md` frontmatter:

```json
{ "enabled_capabilities": ["phone"] }
```

Until you do this the skill is registered but invisible to the model.

### 4. Check it is on

Ask the assistant to make a call. Without configuration it answers plainly rather than failing:

> Calling is not configured on this install, so no call was placed.

### What it costs

Per-minute, on someone else's meter. Retell bills by the minute at a rate that depends on the model
and voice; a carrier number is typically a small monthly fee on top. The dashboard's Budget block
does **not** track this — it counts the assistant's own model spend, not the telephony provider's.

---

## Writing your own

The shape generalises to anything you delegate and cannot supervise: a long research run, a
document pipeline, a negotiation over email.

1. **Write the two contracts first.** What does the delegate need to know, and what must it come
   back with? If you cannot write the result contract, you do not yet know what you are delegating.
2. **List what it may not do,** not only what it may.
3. **Force a fallback.** Refuse the job if the caller has not said what failure looks like.
4. **Put the non-negotiable rules where the caller cannot reach them.**
5. **Return typed structure,** and be honest in it about what you could not determine.
6. **Gate it three ways** — capability, configuration, approval — so it is off unless wanted.

The telephony in this example is incidental. The contracts are the point.
