# Contributing

Thanks for considering a contribution.

## Before You Start

- Read the [setup guide](./docs/SETUP_ZH.md) if you want to run the bridge locally.
- Keep changes focused. Small, reviewable pull requests are much easier to merge.
- If your change affects behavior, update docs and examples in the same PR.

## Local Workflow

```powershell
npm install
npm run build
npm test
```

For local development:

```powershell
npm run dev
```

## What To Include In A PR

- A clear description of the problem
- What changed and why
- Any screenshots, logs, or chat transcripts if the change affects UX
- Notes about risk, migration, or follow-up work if relevant

## Good First Contributions

- Better setup docs
- Safer approval policies
- Better error messages
- Demo assets and screenshots
- More granular workspace / command controls

## Ground Rules

- Do not commit secrets such as `.env`
- Do not widen default permissions without documenting the tradeoff
- Prefer simple, reviewable changes over broad rewrites
