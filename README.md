# pa-utilities

Playwright-based automation for PythonAnywhere ("PA") accounts on the free tier, where there's no way to `git pull`, reload a webapp, or renew the account's uptime except by clicking through the web UI. Both scripts drive that UI directly (plus PA's REST API for the parts a browser can't do reliably) instead of screen-scraping raw HTML with something more fragile.

## Scripts

### `deploy.js` — pull latest code and reload the webapp

1. Deletes any consoles left open on the account (free tier caps this at 2, and a crashed run can leave one behind).
2. Logs into PA and opens a fresh Bash console via the web UI (PA's console-create API allocates a record but doesn't actually start the process until something loads the console page in a browser — an undocumented quirk).
3. Runs `cd $PA_WORKING_DIR && git pull` in that console via the REST API's `send_input`/`get_latest_output` (PA's console here renders to canvas, not DOM text, so reading output back only works through the API).
4. Reloads `$PA_DOMAIN` via the REST API, falling back to clicking the Reload button on the webapps page if the API call fails.

Required environment variables: `PA_USERNAME`, `PA_PASSWORD`, `PA_API_TOKEN`, `PA_WORKING_DIR`, `PA_DOMAIN`.

### `renew.js` — keep a free-tier account from expiring

Free PA accounts get disabled after ~3 months unless someone logs in and clicks "Run until 1 month from today." This just does that click on a schedule.

Required environment variables: `PA_USERNAME`, `PA_PASSWORD`.

## Using `deploy.js` from another repo

`deploy-pythonanywhere.yml` is a **reusable workflow** — call it from the repo whose pushes should trigger a deploy:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    uses: jaiparmani/pa-utilities/.github/workflows/deploy-pythonanywhere.yml@main
    with:
      pa_working_dir: /home/yourusername/yourproject
      pa_domain: yourusername.pythonanywhere.com
    secrets:
      PA_USERNAME: ${{ secrets.PA_USERNAME }}
      PA_PASSWORD: ${{ secrets.PA_PASSWORD }}
      PA_API_TOKEN: ${{ secrets.PA_API_TOKEN }}
```

`renew-pythonanywhere.yml` isn't reusable — it just runs on its own daily schedule inside this repo, since it isn't tied to any other repo's push events.

## Setup

1. Get a PA API token from the PA dashboard's "API Token" tab.
2. Add `PA_USERNAME`, `PA_PASSWORD`, and `PA_API_TOKEN` as secrets — on this repo (for `renew.js`, and if you want to test `deploy.js` directly here) and/or on any repo that calls the reusable deploy workflow.
3. For `deploy.js`, confirm the actual source-code path and webapp domain from the PA "Web" tab — they don't necessarily match the account username (e.g. a webapp's source can live in a differently-named subdirectory, or the account can serve a domain that isn't `<username>.pythonanywhere.com`).

## Notes / known fragility

- Runs inside Microsoft's official Playwright Docker image (`mcr.microsoft.com/playwright`) rather than installing chromium via `apt-get` on `ubuntu-latest` — that mirror hung repeatedly (once for 6+ hours) when this ran on the bare runner.
- Selectors for PA's "start a new console" link and the Reload button are best-effort matches against PA's actual markup, with fallback chains, since PA doesn't document its UI structure. If PA changes its markup, `deploy.js` will fail with a screenshot artifact (`git-pull-error.png` / `reload-error.png`) uploaded on failure to help debug.
- Keep the `mcr.microsoft.com/playwright` image tag and the `playwright` npm version pinned to the same release in both workflow files, or the browser binary and the library can drift out of sync.
