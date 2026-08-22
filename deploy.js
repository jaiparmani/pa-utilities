const { chromium } = require("playwright");

const PA_USERNAME = requireEnv("PA_USERNAME");
const PA_PASSWORD = requireEnv("PA_PASSWORD");
const PA_API_TOKEN = requireEnv("PA_API_TOKEN");
const PA_WORKING_DIR = requireEnv("PA_WORKING_DIR");
const PA_MIGRATE_DIR = process.env.PA_MIGRATE_DIR || "";
const PA_PYTHON = process.env.PA_PYTHON || "python3.12";
const PA_DOMAIN = requireEnv("PA_DOMAIN");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const API_BASE = `https://www.pythonanywhere.com/api/v0/user/${PA_USERNAME}/`;

async function paApi(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Token ${PA_API_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (res.status === 204) return null;

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes("application/json")) {
    const bodySnippet = (await res.text()).slice(0, 300);
    throw new Error(
      `PA API ${options.method || "GET"} ${path} failed: ${res.status} (content-type: ${contentType || "none"}) ${bodySnippet}`
    );
  }

  return res.json();
}

// PA's free tier only allows 2 open consoles at a time, and past runs have
// left orphaned ones behind (crashed before cleanup, or reused a stale one).
// Kill everything open before starting a fresh console so we never hit that
// cap.
async function killExistingConsoles() {
  const consoles = await paApi("consoles/");
  for (const c of consoles) {
    console.log(`Killing existing console ${c.id} (${c.executable})...`);
    await paApi(`consoles/${c.id}/`, { method: "DELETE" }).catch((err) => {
      console.log(`Failed to delete console ${c.id}: ${err.message}`);
    });
  }
}

// The REST API's consoles/ POST (create-a-console) can consistently return
// a 200 with PA's marketing homepage HTML instead of JSON - looks like a
// rate-limit/redirect tripped by heavy login/API traffic in a short window.
// Browser-based console creation (clicking "Bash" on the consoles page,
// like a human) is more reliable - and separately, PA's terminal renders to
// canvas, so there's no DOM text to read output back from anyway. So:
// create/start the console via the browser, then drive
// send_input/get_latest_output/delete through the REST API for that
// existing console id, which returns real, readable text.
async function startConsoleViaBrowser() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://www.pythonanywhere.com/login/", {
      waitUntil: "networkidle",
    });

    await page.fill('input[name="auth-username"]', PA_USERNAME);
    await page.fill('input[name="auth-password"]', PA_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click('button[type="submit"]'),
    ]);

    console.log(`[gitPull] Logged in. Page title: "${await page.title()}"`);

    await page.goto(`https://www.pythonanywhere.com/user/${PA_USERNAME}/consoles/`, {
      waitUntil: "networkidle",
    });

    console.log(`[gitPull] On consoles page. URL: ${page.url()}, title: "${await page.title()}"`);

    // The "start a new console" Bash link's text is "$ Bash" (shell-prompt
    // style), not plain "Bash" - a plain "Bash" match instead lands on a
    // "Recent Consoles" entry like "Bash console 12345678" (reusing an old,
    // long-lived console instead of starting a fresh one). Try the "$ Bash"
    // form first, then looser fallbacks, but always reject any match
    // containing a digit (a console id) so we never accidentally reattach
    // to a Recent Consoles entry.
    const bashCandidates = [
      page.getByRole("link", { name: "$ Bash" }),
      page.locator("a", { hasText: /^\$?\s*Bash\s*$/ }),
      page.locator("a:has-text('Bash')"),
    ];

    let clicked = false;
    for (const candidate of bashCandidates) {
      const count = await candidate.count();
      for (let i = 0; i < count; i++) {
        const locator = candidate.nth(i);
        try {
          const text = (await locator.innerText()).trim();
          if (/\d/.test(text)) continue; // skip Recent Consoles entries
          await locator.waitFor({ state: "visible", timeout: 8000 });
          await locator.click();
          clicked = true;
          break;
        } catch (err) {
          console.log(`[gitPull] Bash selector attempt failed: ${err.message}`);
        }
      }
      if (clicked) break;
    }

    if (!clicked) {
      console.log("[gitPull] Could not find a 'Bash' start-console link. Dumping page text for debugging:");
      console.log((await page.innerText("body")).slice(0, 3000));
      throw new Error("Could not locate the 'Bash' start-console control on the consoles page.");
    }

    for (let i = 0; i < 15 && !/\/consoles\/\d+/.test(page.url()); i++) {
      await page.waitForTimeout(1000);
    }

    const match = page.url().match(/\/consoles\/(\d+)/);
    if (!match) {
      throw new Error(`Console page URL never showed a console id: ${page.url()}`);
    }

    // give the console's websocket a moment to actually spin up the process
    await page.waitForTimeout(5000);

    return match[1];
  } catch (err) {
    await page.screenshot({ path: "git-pull-error.png", fullPage: true });
    throw err;
  } finally {
    await browser.close();
  }
}

async function gitPull() {
  await killExistingConsoles();

  console.log(`Starting console via browser for ${PA_WORKING_DIR}...`);
  const consoleId = await startConsoleViaBrowser();
  console.log(`Console ${consoleId} started.`);

  try {
    await paApi(`consoles/${consoleId}/send_input/`, {
      method: "POST",
      body: JSON.stringify({ input: `cd ${PA_WORKING_DIR} && git pull\n` }),
    });

    let output = "";
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const chunk = await paApi(`consoles/${consoleId}/get_latest_output/`);
      output += chunk.output;
    }

    console.log("git pull output:\n" + output);

    // Pulling code that adds a Django app leaves the server without that app's
    // tables until someone runs migrate by hand - the failure looks like
    // "no such table", long after the deploy reported success. Apply them here,
    // in the same console, while the new code is on disk and before the reload.
    if (PA_MIGRATE_DIR) {
      console.log(`Applying migrations in ${PA_MIGRATE_DIR}...`);
      await paApi(`consoles/${consoleId}/send_input/`, {
        method: "POST",
        body: JSON.stringify({
          input: `cd ${PA_MIGRATE_DIR} && ${PA_PYTHON} manage.py migrate --noinput\n`,
        }),
      });

      let migrateOut = "";
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const chunk = await paApi(`consoles/${consoleId}/get_latest_output/`);
        migrateOut += chunk.output;
      }
      console.log("migrate output:\n" + migrateOut);

      // The console reports command output as text, not an exit code, so look
      // for the shapes a failure takes rather than trusting the call returned.
      if (/Traceback|CommandError|No such file or directory|command not found/i.test(migrateOut)) {
        throw new Error(
          "Migrations did not apply cleanly - see the migrate output above. " +
          "Check pa_migrate_dir points at the directory holding manage.py, and " +
          "that pa_python is an interpreter with Django installed."
        );
      }
    }
  } finally {
    await paApi(`consoles/${consoleId}/`, { method: "DELETE" });
  }
}

// Click the Reload button on PA's webapps page. Kept as a fallback in case
// the REST API reload call (tried first in reloadWebapp()) ever misbehaves -
// PA's reload API has been seen returning a 500 when targeting a domain the
// authenticated account doesn't actually own.
async function reloadWebappViaBrowser() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://www.pythonanywhere.com/login/", {
      waitUntil: "networkidle",
    });

    await page.fill('input[name="auth-username"]', PA_USERNAME);
    await page.fill('input[name="auth-password"]', PA_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click('button[type="submit"]'),
    ]);

    console.log("✅ Logged in");

    await page.goto(`https://www.pythonanywhere.com/user/${PA_USERNAME}/webapps/`, {
      waitUntil: "networkidle",
    });

    const reloadSelectors = [
      `input[value="Reload ${PA_DOMAIN}"]`,
      'input[value^="Reload "]',
      'input[value*="Reload" i]',
      'button:has-text("Reload")',
      'text=/Reload/i',
    ];

    let clicked = false;
    let lastErr;
    for (const selector of reloadSelectors) {
      try {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout: 5000 });
        await locator.click();
        clicked = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!clicked) {
      throw new Error(
        `Could not find a visible Reload button on the webapps page for ${PA_DOMAIN}: ${lastErr}`
      );
    }

    await page.waitForLoadState("networkidle", { timeout: 30000 });
    console.log(`✅ Reloaded ${PA_DOMAIN} (via browser click)`);
  } catch (err) {
    await page.screenshot({ path: "reload-error.png", fullPage: true });
    throw err;
  } finally {
    await browser.close();
  }
}

async function reloadWebapp() {
  try {
    await paApi(`webapps/${PA_DOMAIN}/reload/`, { method: "POST" });
    console.log(`✅ Reloaded ${PA_DOMAIN} (via API)`);
  } catch (err) {
    console.log(`Reload API failed (${err.message}); falling back to clicking the button directly.`);
    await reloadWebappViaBrowser();
  }
}

(async () => {
  try {
    await gitPull();
    await reloadWebapp();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
