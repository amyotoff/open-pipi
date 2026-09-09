# LLM Gateway

Application code uses one contract for messages, images, JSON Schema tools, tool results and token usage. `src/core/llm-gateway.ts` translates that contract into a single HTTP request; `src/core/llm.ts` owns orchestration, retries, advisor calls and execution integrity. There is no provider SDK or extra agent framework. Route policy lives in `src/core/llm-config.ts`, outside the transport adapter.

```text
App → LLM Gateway ┬→ Text / classification / rewriting → OpenRouter (default)
                 │                                     Claude / GPT / Gemini / Qwen / open models
                 ├→ Tool loops / vision → direct API (Gemini default)
                 │                        OpenAI / Anthropic / Gemini
                 └→ Native grounding → Gemini direct (default)

Each route is configurable; OpenRouter is an explicit option for tool and vision experiments.
```

## Configuration

Set variables in your deployment environment. Only the selected text provider's key is required to start. The default full assistant setup uses both `OPENROUTER_API_KEY` for text and `GEMINI_API_KEY` for tools, vision and grounding. Setup checks warn about missing capability keys; invoking an unconfigured route fails explicitly. The gateway never silently chooses a different cloud provider because another key happens to exist.

| `LLM_PROVIDER` | Required key | Executor default | Advisor default |
| --- | --- | --- | --- |
| `openrouter` (default) | `OPENROUTER_API_KEY` | `google/gemini-2.5-flash` | `anthropic/claude-sonnet-4.6` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` | `gpt-4.1` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | `gemini-3-pro-preview` |

Override the text defaults with `LLM_EXECUTOR_MODEL` and `LLM_ADVISOR_MODEL`. OpenRouter accepts its catalog IDs verbatim, including `anthropic/...`, `openai/...`, `google/...`, `qwen/...` and open-weight models; direct APIs use their native model IDs. Model availability and context limits depend on the selected model and account; the gateway does not claim every model supports every capability.

| Workload | Provider setting | Default |
| --- | --- | --- |
| Text, cloud classification, rewriting, one-shot generation, advisor | `LLM_PROVIDER` | `openrouter` |
| Turns with available tools, including WebRun | `LLM_TOOLS_PROVIDER` | `gemini` when text uses OpenRouter; otherwise the selected direct text provider |
| Image analysis | `LLM_VISION_PROVIDER` | Same rule as tools |
| Search / native grounding | `LLM_SEARCH_PROVIDER` | `gemini` |

Set `LLM_TOOLS_MODEL` to a tool-capable model and `LLM_VISION_MODEL` to an image-capable model. These overrides take precedence. Tools and vision otherwise inherit the executor model when they use the same provider as text. Switching a capability to a different provider selects that provider's native default model; OpenRouter model IDs are never copied onto a direct route. Search has its own default model independently of the text executor.

Routing is explicit at the call site: a turn exposing tools uses the tool route even if the model ultimately makes no tool call. Calls with `allowedTools: []`, Brain generation and bootstrap use the text route. Notes, context summaries, onboarding analysis and Ollama's cloud text fallback explicitly disable tools. Existing local Ollama classification and simple-reply paths remain local; cloud text uses the configured text route.

For example, an OpenRouter executor/advisor split:

```dotenv
LLM_PROVIDER=openrouter
LLM_EXECUTOR_MODEL=openai/gpt-4.1-mini
LLM_ADVISOR_MODEL=anthropic/claude-sonnet-4.6
```

For OpenRouter text with direct Anthropic tools and vision:

```dotenv
LLM_PROVIDER=openrouter
LLM_TOOLS_PROVIDER=anthropic
LLM_TOOLS_MODEL=claude-sonnet-4-6
LLM_VISION_PROVIDER=anthropic
LLM_VISION_MODEL=claude-sonnet-4-6
LLM_SEARCH_PROVIDER=gemini
```

This split uses OpenRouter, Anthropic and Gemini keys for their respective capabilities. For direct Anthropic text, tools and vision, set `LLM_PROVIDER=anthropic` and omit capability overrides; search remains a separate Gemini route. For an OpenRouter-only experiment, explicitly set `LLM_TOOLS_PROVIDER`, `LLM_VISION_PROVIDER` and `LLM_SEARCH_PROVIDER` to `openrouter`. `PIPI_ADVISOR_ENABLED` and `PIPI_ADVISOR_MAX_CALLS_PER_TURN` keep their existing meaning.

### Existing installations

A Gemini-only installation must add **`LLM_PROVIDER=gemini`** to retain its direct routes, or configure `OPENROUTER_API_KEY` for text while keeping Gemini for native capabilities. `GEMINI_EXECUTOR_MODEL` remains a fallback for Gemini routes, and `GEMINI_ADVISOR_MODEL` for a Gemini text advisor; the corresponding `LLM_*_MODEL` overrides take precedence. Existing `.env` files and production configuration are not rewritten by this change. New installs should copy the public `config.example` template, as shown in the installation guide. The legacy `.env.example` is retained unchanged; verify the selected routes with `pnpm setup:check -- --json`.

### Search is a separate capability

`LLM_SEARCH_PROVIDER` accepts `openrouter` or `gemini` and defaults to Gemini direct for native grounding, independently of the text provider. `LLM_SEARCH_MODEL` overrides the selected route's default. The search route needs its own corresponding key only when used; it does not block text startup.

OpenRouter search uses the `openrouter:web_search` server tool with a three-call ceiling; Gemini uses Google Search grounding. Both normalize provider citations into the same source list. A reply without citations is treated as a failed search. The OpenRouter server tool is currently beta. Native OpenAI/Anthropic web-search tools are outside this small adapter; those direct inference routes can use either of the two separate search routes above.

## Continuation and failure behavior

- Every tool result carries the original call ID, including multiple calls with the same name. Tool execution remains serialized under the existing policy/approval checks.
- The gateway preserves opaque provider continuation state: OpenRouter reasoning details, Anthropic content blocks and Gemini signed parts. State cannot cross providers or models inside a tool loop.
- The tool provider and model are fixed for the entire turn, including retries and finalization. Missing credentials or failures on a native capability never trigger an automatic switch to OpenRouter or Ollama. Pure text retains the existing Ollama fallback; advisor requests use the text route without tool continuation state.
- Finalization retains tool declarations for native APIs that require them with prior tool history, while explicitly setting tool choice to `none`.
- Requests abort at the configured deadline (45 seconds by default; background one-shot calls default to 60 seconds). HTTP status is retained for retries without exposing upstream error bodies.
- Reasoning is a best-effort hint, mapped for OpenRouter and Gemini. Direct OpenAI reasoning models omit unsupported temperature; Anthropic uses its model default. This gateway does not enable streaming or implement a model-capability catalog.

## Usage and cost

Chat, advisor, finalization, vision, Brain, WebRun and search share normalized input/output counts. OpenRouter's reported `usage.cost` is stored as-is, including zero-cost responses. Local Ollama usage is free. The existing `token_usage` table is reused; no database migration is needed.

Direct routes use the price table in `src/db.ts`; these are estimates, not invoices (cache tiers and native search surcharges can differ). Unknown prices are stored as SQL `NULL` and counted as `unpriced_calls`. The dashboard, health summary and `/status` warn when totals exclude calls. **The daily cost guard only covers known spend**; use provider-side spending limits for unpriced models. Historical rows are not repriced.

## Protocol references

- [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling) and [reasoning continuation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [OpenRouter server web search](https://openrouter.ai/docs/guides/features/server-tools/web-search)
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/http/messages) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)

Transport contract tests mock `fetch`; they cover routing, credentials, tool-ID and signed-state round trips, images, citations, usage, errors and cancellation without paid API calls. Model-specific quality and live account access require an operator smoke test with their chosen route.
