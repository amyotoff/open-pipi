# Open PiPi onboarding MVP — design QA

final result: passed

## Installation lab update — 2026-09-10

The current page follows the light gray/Helvetica/large centered heading reference, with
“Automatic setup” / “Автоматическая установка” and an experimental test-bench subtitle. The
GitHub URL is visible beside the handoff. Labeled native selectors choose client and scenario,
and the ordinary-chat limitation appears before the controls. The hero no longer markets PiPi.

Real Chrome screenshots were inspected at desktop 1440×1000 and phone 390×844. E2E also checked
Russian layout at 320px. The first run found overflow from the long Russian heading; reducing the
phone font size fixed it. All 44 browser checks passed on rerun. No observed layout or interaction
blockers remain. Screenshots are generated under `output/playwright/` and attached to CI as
`onboarding-browser`.

The current E2E confirms exact clipboard contents and the denied-clipboard manual path,
all 36 client/scenario/language prompts, language retention, no-JavaScript guidance and readable
instruction links. This supersedes the older limited clipboard evidence below. It does not claim
that an actual coding agent installed software or sent a Telegram message.

## Target and evidence

- Source visual: `/var/folders/3p/pk2z70f14375nfgqndnf8_680000gq/T/codex-clipboard-250c91d8-f35e-43d2-bdb7-e0e365acc1b5.png` (2460 × 580 pixels).
- User scope: the reference's header style, with Helvetica, light gray background, and a large centered heading for Open PiPi.
- Implementation: <https://open-pipi-onboarding-mvp.amyote.workers.dev/>.
- Desktop screenshot: `.tmp/onboarding-desktop.png` (1440 × 1000 CSS/pixel dimensions, DPR 1).
- Mobile screenshots: `.tmp/onboarding-mobile.png` and `.tmp/onboarding-mobile-action.png` (390 × 844, DPR 1).
- State: Russian, new-install prompt; existing-install and English states inspected separately.

The source is a cropped header style reference, not a full-page product mock. The source and
desktop screenshot were opened together in one comparison input. Comparison evaluates the stated
style and responsive adaptation, not pixel identity of different text or the source brand. The
initial 2460-wide browser capture exceeded the in-app capture surface and produced clipped/tiled
output; it was discarded. The valid 1440-wide capture was used for desktop judgment, with source
and implementation dimensions stated explicitly above. No device-density conversion was needed.

## Fidelity surfaces

- Typography: computed family is `Helvetica Neue, Helvetica, Arial, sans-serif`. Large, tightly
  spaced black heading; smaller gray product name above it. The brand and headline remain editable
  text. No source logo or decorative star was recreated; the user requested the style for PiPi.
- Spacing: sparse navigation, generous centered hero, one restrained prompt card underneath, and
  a simple three-step explanation. Mobile stacks the content without horizontal overflow:
  `innerWidth` and `documentElement.scrollWidth` both measured 390.
- Colors: body computed as `rgb(245, 245, 245)` per the requested light gray; near-black main
  typography and monochrome controls. No gradients, illustration placeholders, or visual clutter.
- Images: this PiPi adaptation has no raster assets. The source brand assets are not part of the
  requested product and were not copied or approximated.
- Copy: product-specific Russian and English; explicit distinction between public instructions
  and the local runtime, human connection steps, and a verified Telegram reply.

The header and mobile prompt/action area were inspected at readable scale, so no extra magnified
region was required. No actionable P0/P1/P2 visual issues were found; no visual code changes were
made after this comparison. The capture-format retry above was evidence normalization, not a
product-fix iteration.

## Interactions and runtime checks

- RU/EN switch updates headline, instructions, and controls.
- New/existing choice updates the prompt and selected state, preserving the existing-install intent.
- Copy invokes Clipboard API and displays success on desktop/mobile. The in-app session clipboard
  readback did not confirm the native clipboard contents, so verification is limited to the
  successful API result and displayed prompt; paste into an external agent remains a tester step.
- The private-runtime FAQ expands and reveals the correct local-host explanation.
- Console warning/error log was empty after these interactions.
- All public routes returned 200 with expected MIME via curl; private setup/API/MCP routes returned 404.
- Temporary viewport override was reset and the user-facing browser tab was retained.

Local preview startup was rejected by automatic approval review as persistent startup without
separate opt-in. The user-authorized Cloudflare test deployment supplied the actual browser QA
surface; no local setup or bot runtime was launched for this check.

## Follow-up

Run a real tester session with their chosen coding agent and private AI/Telegram connections.
The automated build task has not sent a live Telegram message or used a paid AI provider.
