---
name: vision
description: >-
  Delegate visual tasks to a vision model when:
  (1) an image needs interpreting — user message, given path, or
  tool-result screenshot (chrome-devtools_take_screenshot,
  playwright_browser_take_screenshot, and similar);
  (2) a task needs pixel-level judgment — position, color, contrast,
  layout — or the user asks to visually verify or check something.
---

# Vision

Delegate via the `vision` tool.

## Step 1. Detect

Your job is to delegate. If the answer requires pixel judgment, delegate. If the
text or AX tree can answer it, answer directly.

Visual intent arrives from four sources:

**Source A - explicit visual language in a user prompt:**
Trigger words: "visually verify", "visually check", "screenshot shows",
"looks right/wrong/broken", "centered", "aligned", "overlapping", "misaligned",
"visible", "hidden", "not showing", "readable", "legible", "low contrast",
"matches the design", "matches the mockup".

**Source B - gap between text output and a visual criterion:**
A browser or computer-use tool may return a screenshot path plus a text
description of the screen. If the user's criterion is positional, color,
readability, layout, or visual comparison, the text tree cannot fully answer it.

**Source C - image attachment in a tool result:**
When a tool result contains an image (e.g. you called `read` on a screenshot
path and got back "Read image file [...]"), delegate with that path instead of
trying to read images yourself.

**Source D - image attached to a user message:**
User-dropped images are materialized as text markers like:
`[vision:dropped-image] {"mime":"image/png","path":"/tmp/...","originalFilename":"..."}`
Parse the JSON and use `path` as the image path.

**Criterion:** you've identified which sources apply, which images are needed,
and what the images show at a high level.

## Step 2. Extract visual intent

Convert the request into a direct visual task. Capture:

- The exact visual question to answer.
- Which images are needed and why.
- Whether the answer is a pass/fail check, a description, a comparison,
  a measurement, or a state read.
- What evidence to cite back to the user.
- What uncertainty or failure path is appropriate.

**Criterion:** you've captured the exact visual question, the images needed, the
answer type (pass/fail, description, comparison, measurement, state read), and
the shape of the response template.

## Step 3. Gather image paths

| Source | How to get the path |
| ------ | ------------------- |
| User-provided | Use the path the user gave. |
| User-dropped image | Parse `[vision:dropped-image]` JSON, use `path`. |
| chrome-devtools MCP | `take_screenshot({ filePath: "/tmp/shot.png" })` |
| Playwright MCP | `take_screenshot({ filename: "shot.png" })` |
| `read` on an image | Delegate with the file path you read from. |

Assign each image a contract ID (`current`, `before`, `after`, `reference`, `detail`).

## Step 4. Delegate

Call the `vision` tool:

```js
vision({
  task: "<one or two sentences describing the exact visual question>",
  images: ["<path1>", "<path2>"],
  template: JSON.stringify({
    "<conclusion>": "<value>",
    "evidence": "<what you see>",
    "uncertainty": null
  })
})
```

Build the smallest JSON template that answers the user's question. Use booleans,
enums, numbers, and arrays over vague prose. The vision model must emit exactly
one JSON object matching this template (it retries once internally if malformed).

**Completion criterion:** the tool returns JSON matching your template. If keys
are missing, call `vision` again, including the previous response in `task` and
keeping the same `template`.

If the tool reports "No vision model configured", call `select_vision_model`
first — omit its `model` argument, the picker opens for the user — then retry.

## Step 5. Report

Cite the evidence fields from the response at their original confidence level.
