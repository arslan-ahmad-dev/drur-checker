# DRUR CHECKER

DR / UR / Organic-traffic checker. Takes a list of domains and returns each
domain's Domain Rating, URL Rating and Organic traffic, read from the **Ahrefs
toolbar bar** injected by the bundled ToolsMandi proxy extension.

## Flow

1. Launch a persistent **bundled Chromium** context with the `extension/`
   (ToolsMandi "Toolwaly Ahrefs Bar") loaded.
2. Auto-login the extension via its popup using `BAR_USERNAME` / `BAR_PASSWORD`.
   The extension proxies all `ahrefs.com/v4/*` calls to `toolsmandi.com/bar/v4/*`
   (with an `X-TM-Token` header), so the toolbar renders without a real Ahrefs
   login.
3. For each domain, open `https://<domain>` (in parallel, capped by
   `MAX_PARALLEL`), wait for `div.ah_barstats-wrapper`, and read **DR / UR / ST**
   off the bar.

No Discord alerts, no ELK logging, no Google scraping.

### Session management
- The session persists in the `bar_profile/` Chrome profile — logged in once,
  reused on every restart.
- The session token is also written to `.bar_session`; if the tool crashes and
  leaves a stuck session, the next start calls `logout.php` with it first, then
  logs in fresh (crash recovery).

## Setup

```bash
pip install -r requirements.txt
python -m playwright install chromium
```

Unzip the bar extension into `extension/` (already done: `extension.zip`).
Fill `BAR_USERNAME` / `BAR_PASSWORD` in `.env`.

## Run

```bash
python main.py
```

## API

`POST /drur` — form field **`domains`** (comma-separated), nothing else.

```bash
curl -X POST http://localhost:8000/drur -d "domains=ft.com,bbc.com"
```

```json
{
  "results": [
    { "domain": "ft.com", "data": { "domain_rating": "92", "url_rating": "57",
      "organic_traffic": "1.8M", "message": "success", "status_code": 200 } }
  ]
}
```

Status codes: `200` success · `406` social/login domain skipped · `408` bar did
not load in time · `400` invalid domain (DNS) · `502` site not reachable.

## Important: single-device login

The ToolsMandi bar account is locked to **one active device**. The tool holds
that one session, so:

- Run only **one** instance, and do **not** stay logged in to the bar in another
  browser while it runs — the second login gets "account already active on 1
  device" and the tool cannot grab the slot.
- First run only: if the bar is logged in elsewhere, log it out once so the tool
  can take the slot. After that the `bar_profile/` keeps the session.
- Console logs each request (IN / OUT / per-domain failures) with timings.

## Note on values

Metrics are the toolbar's per-URL numbers for the domain's homepage, so UR and
traffic can differ from Ahrefs Site Explorer's domain-level (subdomains) figures.
