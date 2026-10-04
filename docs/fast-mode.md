# Shared Fast mode

`/omp` has one Fast switch (`fast` in `omp.json`). When on, every main, specialist and Council request uses the Fast capability available for its provider/model. When off, OMP adds no Fast parameters; it does not delete settings supplied by another extension or provider. Changing the switch takes effect on the next request, including retries and warm child processes.

## Automatic support

| Provider / transport | Policy |
| --- | --- |
| OpenAI Responses and Chat Completions; Codex Responses including account aliases | `service_tier: "priority"` |
| Anthropic Messages, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8` | `speed: "fast"`, with the `fast-mode-2026-02-01` beta header through the native SDK |
| Groq Chat Completions | `service_tier: "auto"`: Groq selects the best tier available to the account; its enterprise low-latency tier is called `performance`, not `priority` |

Anthropic's listed models require Fast preview access. Other Claude models are not assumed to support Fast: for example, Opus 4.7 rejects it and Opus 4.6 runs at standard speed. A supported model does not prove account entitlement. Normal provider errors and retry policy still apply; OMP does not silently resubmit paid requests in another tier.

## Custom and restricted endpoints

Pi does not expose a universal Fast capability or account-entitlement discovery API. An OpenAI-compatible schema alone is not proof of priority support. Unknown endpoints remain unchanged until support is declared. This is capability metadata, not a second independent Fast switch:

```json
{
  "fast": true,
  "fastProviders": {
    "my-openai-proxy": "openai-priority",
    "my-claude-proxy/claude-opus-5-5": "anthropic-fast",
    "my-dedicated-cerebras": "cerebras-auto"
  }
}
```

Only declare capabilities actually supported by the endpoint and account. Exact `provider/model` entries take precedence over provider entries; `"off"` excludes an unsupported model or endpoint. Declarations are retained when `/omp` settings change.

| Declaration | Compatible Pi API | Parameters |
| --- | --- | --- |
| `openai-priority` | OpenAI Responses, Chat Completions, Codex Responses, Azure Responses | `service_tier: "priority"` |
| `anthropic-fast` | Anthropic Messages | `speed: "fast"` plus the Fast beta; existing betas are preserved |
| `groq-auto` | OpenAI Chat Completions | `service_tier: "auto"` |
| `groq-performance` | OpenAI Chat Completions | `service_tier: "performance"`; requires Groq enterprise access |
| `cerebras-auto` | OpenAI Chat Completions | `service_tier: "auto"`; requires an eligible dedicated endpoint / preview access |
| `bedrock-priority` | Bedrock Converse Stream | `serviceTier: { "type": "priority" }`; declare only for supported model/profile IDs |
| `off` | Any | No OMP Fast override |

Cerebras shared and customer-trial endpoints do not universally support tiers. Bedrock availability is model-specific. Azure and third-party proxies are not automatically assumed to implement OpenAI Priority merely because they speak a similar API.

Gemini's documented Priority feature currently targets the Interactions API, whereas Pi's Google adapter uses `generateContentStream`. OMP does not inject Interactions-only fields into this different transport. This is not a claim that every service with a Fast product is already covered: unsupported transports need an adapter, and future models may need capability declarations or an updated compatibility table.

Fast mode does not switch models, reduce thinking effort, or shorten output. Premium billing and response-tier downgrades are controlled by providers; OMP's normal model-based cost estimates may not reflect premium surcharges.

## References

Checked against provider documentation for this implementation:

- [OpenAI Priority processing](https://developers.openai.com/api/docs/guides/priority-processing)
- [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- [Groq service tiers](https://console.groq.com/docs/service-tiers)
- [Cerebras Chat Completions: service_tier](https://inference-docs.cerebras.ai/api-reference/chat-completions)
- [Bedrock service tiers](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html)
- [Gemini Priority inference](https://ai.google.dev/gemini-api/docs/priority-inference)

Tests are offline. They verify payload selection, configuration changes and the Anthropic SDK's actual body/header serialization, not access to paid provider accounts.
