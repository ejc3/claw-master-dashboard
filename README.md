# claude-master dashboard

Which subscription has headroom, when each window resets, who uses the pool, and whether
requests succeed: a dashboard for [claw-master](https://github.com/ejc3/CLIProxyAPI/blob/feature/claude-master-inference/docs/claw-master.md)
telemetry, packaged to mount in any Next.js app.

Design and delivery plan: [docs/architecture.md](docs/architecture.md).

## Mount it in a Next.js app

```ts
// next.config.ts
export default { transpilePackages: ['@ejc3/claw-master-dashboard'] }

// app/layout.tsx
import '@ejc3/claw-master-dashboard/styles.css'

// app/api/claw-master/[...path]/route.ts
import { createDashboardHandler } from '@ejc3/claw-master-dashboard/next'
export const { GET } = createDashboardHandler({ source, authorize })

// app/claw-master/page.tsx
import { DashboardPage } from '@ejc3/claw-master-dashboard/next'
export default function Page() {
  return (
    <DashboardPage source={source} authorize={allowed} apiBase="/api/claw-master" unauthorized={<SignIn />} />
  )
}
```

`source` returns a `MetricsSource`: `selectSource(process.env, createDemoSource())` from
`@ejc3/claw-master-dashboard/cloudwatch` picks the CloudWatch source when `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_REGION` are set and the demo fixture otherwise (pass its `kind`
to `DashboardPage` as `demoData` so the page labels made-up numbers). `authorize` is required; nothing is served without it.

Behind Cloudflare Access, create one checker per process (it caches the team's keys) and use it in
both places:

```ts
import { ACCESS_ASSERTION_HEADER, cloudflareAccess } from '@ejc3/claw-master-dashboard/access'
import { headers } from 'next/headers'

const access = cloudflareAccess({ teamDomain, audience, allowedEmails })
// route handler: takes the request
export const { GET } = createDashboardHandler({ source, authorize: access.authorize })
// page: reads the incoming request's headers
const allowed = async () =>
  (await access.identify((await headers()).get(ACCESS_ASSERTION_HEADER))) !== null
```

`apps/web/lib/dashboard.ts` does this, reading the settings from Worker secrets and the allowlist
from a Workers KV binding (`readAllowlist`).

The reference app deploys as a Cloudflare Worker: see [docs/deploy.md](docs/deploy.md).
The look follows an error-monitoring console (pale violet-gray page, quiet panels, one violet
accent, tinted status tags). Every color and shadow is a `--cmd-*` custom property on
`.cmd-root`, so a host restyles it by overriding those. The dashboard's styles sit in the `cmd`
cascade layer, so a host's own (unlayered) override wins in both themes: set its dark values
under the host's dark-mode selector as well. The font is optional: set `--cmd-font-sans` (the reference app
uses Rubik through `next/font`).

## Develop

```bash
pnpm install
pnpm check && pnpm typecheck && pnpm test
cp apps/web/.env.example apps/web/.env.local   # DASHBOARD_AUTH=off skips Access locally
cd apps/web && PORT=<port> pnpm dev
```

Next reads `PORT` from the environment before it loads `.env.local`, so pass it on the command
line. Open the app as `http://localhost:<port>`: Next's development server serves its scripts
only to its own origin.
