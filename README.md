# pi-vision

Give text-only pi models (DeepSeek, GLM, …) eyes: visual tasks delegate to a vision-capable model.

## Install

```bash
pi install git:github.com/udit-001/pi-vision
```

## Use

1. Run `/vision-setup` and pick an image-capable model (or just ask: "set up vision").
2. Drop an image, paste a path, or let a browser tool take a screenshot.
3. Done. The agent delegates and returns structured JSON findings.

Works out of the box with [pi-zen](https://github.com/udit-001/pi-zen) free models — that is the zero-cost way to get a vision model.

## How it works

Text-only orchestrators get a `vision` tool and a delegation skill. Vision-capable models are left alone — they see images natively. Your model choice persists across sessions.

## Tests

```bash
bun test vision-core.test.ts
```

## License

MIT
