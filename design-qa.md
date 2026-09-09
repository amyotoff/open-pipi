# Open PiPi onboarding MVP — design QA

final result: passed

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
