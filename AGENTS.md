# AGENTS.md

A Next.js-mountable dashboard for claude-master telemetry. Design: `docs/architecture.md`.

## Commands

```bash
pnpm install
pnpm check       # biome
pnpm typecheck   # tsc, strict
pnpm test        # vitest
```

## Rules

- `apps/web` pins Next 16.3.8: under OpenNext 1.20.10, Next 16.4 builds and passes
  `wrangler deploy --dry-run` but every request fails at runtime (`Unexpected
  loadManifest(/.next/server/preview-props.json)`). Before raising either version, run the built
  Worker (`pnpm --filter web cf:build`, then `wrangler dev` with an explicit port) and load a page.

- TypeScript stays strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`). Fix types; do not cast around them.
- Relative imports inside `packages/dashboard` are extensionless. The package is always bundled
  by its host (Next `transpilePackages`, Vitest), and Turbopack does not resolve a `.js` or
  `.jsx` specifier to a `.tsx` file.
- Views and sources ask the catalog for semantic metrics; metric names live in
  `src/core/catalog.ts` (tests and docs may quote them).
- Nothing from a real deployment goes into this public repository: no AWS account or role ARN,
  Cloudflare Access team or audience, email address, host name, profile name or model id from a real setup. Tests and
  examples use made-up values (`alpha`, `box-1`, `claude-model-large`).
- Never put secrets in `apps/web/.env*`: OpenNext embeds those files in the Worker it builds, and
  the Deploy workflow fails if a build embeds any. Deploys happen only from that workflow.
- Each change is its own pull request: the gate above, then `/code-review` and an independent
  `codex exec -s read-only` pass, then green CI.

## Cloudflare only, by design (standing rule)

This app deploys to Cloudflare Workers only (the Worker `claw-master-dashboard`, from
`.github/workflows/deploy.yml`), by design: Cloudflare is where the owner's web apps are going,
and this one needs no Vercel project.

- **Every change must work on Cloudflare.** Before merging, CI is green, including the
  Cloudflare build check (`pnpm --filter web cf:check`). The Worker deploys only from `main`,
  so after merging watch the Deploy workflow go green; a red deploy is fixed before anything
  else merges.
- **Use what Cloudflare offers.** A feature may use Workers bindings, KV, D1, R2, Durable
  Objects, Queues or Cron Triggers; nothing needs a Vercel path. Write for the Workers runtime:
  it does not give a Next.js app a writable, persistent filesystem or reading files at runtime
  that are not bundled, and it rejects `fetch(..., { redirect: 'error' })`.
- **App secrets live in AWS Secrets Manager** (administered from `ejc3/aws`) and are set as
  Worker secrets from there, each on stdin: the read-only CloudWatch key from
  `claude-master-dashboard/aws-reader` and the Access values from
  `terraform output claw_master_dashboard` in ejc3/aws. Never commit one, never print one.
  The Cloudflare deploy token is not an app secret and stays with the deploy workflow.
- **Who may sign in is one list, kept in `ejc3/aws`.** Terraform builds the Access policy from it
  and writes the same list to the `DASHBOARD_CONFIG` KV namespace, key `allowed-emails`, which the
  app checks. Never set an allowlist on the Worker by hand or bring back a Worker secret for it.
- **The account aliases come from claw-master's own names.** Terraform derives them from
  `claude-master/account-labels` and writes them to the same namespace, key `account-aliases`.
  Never set aliases on the Worker by hand or bring back a Worker secret for them.
- **Public build-time values** (`NEXT_PUBLIC_*`) are Actions variables mapped into the build
  step of `.github/workflows/deploy.yml` (only the names mapped there reach the build).
