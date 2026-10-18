# Deploying

The reference app (`apps/web`) deploys as the Cloudflare Worker `claw-master-dashboard`, at
https://claw-master-dashboard.cc-games.workers.dev/claw-master. The `Deploy` workflow checks, builds
and deploys it on every push to `main`. It also deletes `claude-master-dashboard`, the Worker's name
before the rename, once ejc3/aws has turned that Worker's URL off and removed its Access application
(ejc3/aws#415); until then the step says it is waiting.

## What lives where

**This repository:** the Worker's code and its URL switches in `apps/web/wrangler.jsonc`.

**`ejc3/aws` (Terraform, `claw-master-dashboard-site.tf`):**
- **The Access application.** It has the Worker as its destination, so once the URLs are on it gates workers.dev and every preview URL. It signs people in with the account's existing Google and one-time-PIN providers (no new OAuth client), and its policy admits the dashboard's operators.
- **The app's allowlist.** A Workers KV namespace, bound here as `DASHBOARD_CONFIG`, whose key `allowed-emails` Terraform writes (comma-separated) from the same list as the Access policy. That list is the only one: to add or remove a person, change it in `ejc3/aws` and apply. Nothing about who is admitted is set on the Worker by hand.
- **The account aliases.** The key `account-aliases` in the same namespace, one `acct-<hash>=NAME` line per person, derived by Terraform from the names claw-master itself uses (`claude-master/account-labels`), with claw-master's own code for each account. Naming an account is one change in `ejc3/aws`.
- **The read-only AWS key.** It is limited to `cloudwatch:GetMetricData` and `cloudwatch:ListMetrics` in one region, and kept in Secrets Manager.

**`ejc3/aws` (Terraform, `workers-deploy.tf`):** the account's Workers deploy token, shared by the site repositories.

**Set by hand, once:**
- the token as the `CLOUDFLARE_API_TOKEN` secret of this repository's `production` environment, with `scripts/workers-deploy-secret.sh` in `ejc3/aws` or `gh secret set --env production`;
- the account id as the environment's `CLOUDFLARE_ACCOUNT_ID` variable;
- the allowlist namespace's id as the environment's `DASHBOARD_CONFIG_KV_ID` variable (`allowlist_kv_namespace_id` in `terraform output claw_master_dashboard`; an id, not a credential). The Deploy workflow puts it in place of the placeholder in `apps/web/wrangler.jsonc`, and fails without it;
- the Worker secrets below.

The `production` environment's deployment branches are limited to `main`, so only the Deploy workflow on `main` can read the token. Until the token exists, the deploy step reports that it skipped.

## Order

An Access application can name a Worker only by its id, which exists after the first deploy:

1. **First deploy.** Merge with `workers_dev` and `preview_urls` false. The first deploy creates the Worker with no public URL.
2. **Adopt the Worker.** Put the Worker's id in `ejc3/aws` and apply. The Access application adopts the Worker; nothing is reachable yet.
3. **Turn the URL on.** Turn `workers_dev` on, here and in `ejc3/aws`, and apply. The URL opens only after Access already covers it.

## Worker secrets

Set from `apps/web` with `wrangler secret put <NAME>`, reading the value from standard input, never the command line. Secrets survive deploys.

| Name | Value |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | The Access team domain, `https://<team>.cloudflareaccess.com` (Terraform output) |
| `CF_ACCESS_AUD` | The Access application's audience tag (Terraform output) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | The read-only key, from its Secrets Manager secret. With all three set the page reads CloudWatch; otherwise it shows the demo fixture and says "Demo data" in its heading |
| `DASHBOARD_ACCOUNT_ALIASES` | Being retired (see "The account aliases" below): read only while the KV key `account-aliases` is missing |
| `DASHBOARD_SERVICE_TOKEN_CLIENT_ID` | Optional. Admits that service token. Access issues one only if the application has a service-auth policy for it, and none is configured |

Without `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD`, or with an invalid one, the app admits nobody and logs which.

## The allowlist

The app checks the address in the Access assertion against the list in KV (`DASHBOARD_CONFIG`, key `allowed-emails`; addresses separated by commas or spaces), so a policy widened by mistake in Access admits no one new. With no binding, no key or an empty list it admits nobody and logs which (`not set: DASHBOARD_CONFIG/allowed-emails (no such key); admitting nobody`, never an address). It reads the list again a minute after the last reading, so a person removed in `ejc3/aws` is refused within about two minutes (KV's cache plus the app's) even while their 24-hour Access session lasts.

It replaced the `DASHBOARD_ALLOWED_EMAILS` Worker secret, which the app no longer reads. The move, in this order so that nobody is locked out:

1. `ejc3/aws` applies the namespace and the key (the list already in it).
2. Set `DASHBOARD_CONFIG_KV_ID` in the `production` environment.
3. Merge the change that reads KV; its deploy binds the namespace. Check that an operator still gets 200 from `/api/claw-master/snapshot`.
4. Only then delete the old secret: `wrangler secret delete DASHBOARD_ALLOWED_EMAILS` from `apps/web`.

Until step 3 the running Worker reads the old secret, which is still there; from step 3 on it reads KV, which already holds the list. A deploy without the variable fails before uploading, so the running version keeps serving.

## The account aliases

Series reported under an account code (`acct-<hash>`) before the server named that account are shown under the person's name, so each person has one row. The aliases are read from KV (`DASHBOARD_CONFIG`, key `account-aliases`): one `acct-<hash>=NAME` line per person, `#` lines skipped, malformed lines ignored and counted in the log. Like the allowlist, they are read again a minute after the last reading. An empty value means no aliases; without the binding or the key the log says which, and the app falls back to the `DASHBOARD_ACCOUNT_ALIASES` Worker secret, only for the move away from it.

The move, in this order:

1. `ejc3/aws` applies the key (the aliases already in it).
2. Merge the change that reads it; from its deploy on, the key is the only source (the secret is ignored while the key exists).
3. Check that the people breakdown still shows one row per person, then delete the old secret: `wrangler secret delete DASHBOARD_ACCOUNT_ALIASES` from `apps/web`. A later change removes the fallback.

Never put secrets in `apps/web/.env*`. OpenNext embeds those files in the Worker it builds. The Deploy workflow fails if a build embeds any.

## After the first deploy with the URL on

- **Not signed in:** a request is redirected to the Access sign-in.
- **Signed in as an operator:** `/api/claw-master/snapshot` answers 200.
- **Signed in with an address not on the allowlist:** it answers 401, and the Worker logs that an address was not on the allowlist.
- **Bypassing Access:** a request sent straight to the Worker with a made-up `Cf-Access-Jwt-Assertion` header answers 401.
