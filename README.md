# pi-vision

Give text-only pi orchestrators (DeepSeek, GLM, and similar models) eyes by
delegating visual tasks to a vision-capable model.

## How it works

| Piece | What it does |
| ----- | ------------ |
| `/vision-setup` command | Set up vision: TUI picker listing **only image-capable models** from your configured providers; choice persists to `~/.pi/agent/vision-model-image.txt`. |
| `select_vision_model` tool | The LLM's way to trigger the same picker (used when the system prompt says `[vision] model=not-configured`, or when the user asks to set up/select/change the vision model in conversation). |
| `input` transform | User-dropped images become `[vision:dropped-image] {"path": ...}` text markers. pi silently strips images for text-only models at the provider layer, so without this the orchestrator would never learn an image existed. |
| `before_agent_start` hint | Appends a terse `[vision] model=...` status line (or `model=not-configured` when unset) to the system prompt of text-only models. |
| `vision` tool | Runs the visual task against the chosen model with the image files attached and a strict JSON template; retries once internally on malformed JSON. |
| `vision` skill | Exposed **only to text-only orchestrators** via `resources_discover` (keyed on the model's `input` capabilities) — vision-capable models never see it in their prompt. Teaches when to delegate and how to build response templates. |

## Usage

1. Set up at least one provider with an image-capable model (e.g. GPT-5, Claude,
   Gemini, Qwen-VL). The picker discovers models automatically from your
   configured providers — it ships no fixed model list.
2. In pi, run `/vision-setup` and pick a model (image-capable only). Or just ask in
   conversation — the agent will open the same picker for you.
3. Drop an image into the input, reference a screenshot path, or let a browser
   tool (chrome-devtools / playwright) take one — a text-only orchestrator will
   delegate to the vision model and relay its structured JSON findings.

Re-pick anytime with `/vision-setup` (or ask the agent to change the vision model).

When your main model is already vision-capable, native multimodality is used —
the plugin stays out of the way. To force native vision off for a task, prepend
`You MUST not use the vision skill.`

## Design

Per the [codebase-design](https://github.com/earendil-works/pi-mono) vocabulary:

- `vision-core.ts` — the deep module: prompt assembly, JSON fence-stripping,
  one-tolerance retry, dropped-image transform. Pure, harness-agnostic.
- `index.ts` — a thin **adapter** at the pi seam: event wiring, tool/command
  registration, TUI picker, skill install.
- `VisionBackend` is the port at the vision-call seam with two adapters: the
  production one (fs + pi-ai `complete`) and the in-memory fake in
  `vision-core.test.ts` — tests cross the same seam callers use.

## Tests

```bash
bun test vision-core.test.ts
```

## License

MIT — see the repo LICENSE.
