# Prompt Radar

> A VS Code extension by [ai4devs](https://ai4devs.github.io) that analyzes prompts-as-code and scores them across five quality dimensions: Security, Safety, Formatting, Efficiency, and Reliability.

## Repository structure

| Path | Contents |
|------|----------|
| `/docs` | Landing page — published via GitHub Pages |
| `/packages/vscode` | Extension source code (TypeScript) |
| `/packages/vscode/package.json` | Extension manifest and dependencies |

## Website

**https://ai4devs.github.io/prompt-radar**

## Scoring categories

| Category | What it measures |
|----------|-----------------|
| Formatting | Clear structure and explicit output expectations |
| Reliability | Specific, stable instructions that reduce ambiguity |
| Efficiency | Concise wording without unnecessary token cost |
| Security | Reduced risk of leakage, injection, or sensitive exposure |
| Safety | Lower risk of harmful, biased, or policy-problematic outputs |

## Development

```bash
cd packages/vscode
npm install
npm run compile
```

## Authors

- [Dr. Vanilson Burégio](https://www.linkedin.com/in/vanilson-buregio/)
- [Dr. Ilyes Jenhani](https://www.linkedin.com/in/ilyes-jenhani-87176124/)

University of Doha for Science and Technology, Doha, Qatar

## License

MIT
