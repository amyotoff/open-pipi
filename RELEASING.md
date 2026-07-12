# Releasing Open PiPi

Keep releases small and reproducible. A release does not deploy any running instance.
Open PiPi is distributed through GitHub Releases; `package.json` is intentionally private and npm publication is out of scope.

## Before tagging

1. Start from a clean, up-to-date `main` branch.
2. Install exactly the locked dependencies with `pnpm install --frozen-lockfile`.
3. Run the complete local gate:

   ```bash
   pnpm release:check
   ```

4. Confirm the `main` GitHub Actions run is green. It independently checks the container,
   committed secrets, and critical container vulnerabilities.
5. Update the version in `package.json` and the README badge when the release number changes.
6. Review the diff for private paths, identities, hostnames, tokens, and generated runtime data.

## Publish

Create an annotated `v<version>` tag from the verified commit, push the tag, and create a GitHub
release with a short list of user-visible changes and known limitations.

Live Telegram, Gemini, Google, WhatsApp, and Discord integrations require credentials and are not
exercised by CI. Smoke-test only the integrations affected by the release on a non-production
instance before updating a running deployment.
