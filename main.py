import time
import uvicorn

from typing import Optional
from datetime import datetime

from fastapi import FastAPI, Form
from contextlib import asynccontextmanager
from fastapi.responses import JSONResponse

from helpers_method.constants import SOCIAL_DOMAINS
from helpers_method.browser_manager import BrowserManager

browser_manager = BrowserManager()


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await browser_manager.start()
    yield
    await browser_manager.shutdown_browser()


app = FastAPI(lifespan=lifespan)


@app.post("/drur-checker")
async def drur(domains: Optional[str] = Form(None)):
    start_time = time.time()

    if not domains or not domains.strip():
        log("IN  /drur rejected: missing 'domains' field")
        return JSONResponse(status_code=400, content={"error": "form field 'domains' is required"})

    domains_list = [d.strip() for d in domains.split(",") if d.strip()]
    log(f"IN  /drur: {len(domains_list)} domain(s) -> {', '.join(domains_list)}")

    social_skipped = {}
    non_social_domains = []

    for domain in domains_list:
        if any(social in domain.lower() for social in SOCIAL_DOMAINS):
            social_skipped[domain] = {
                "domain_rating": "N/A",
                "url_rating": "N/A",
                "organic_traffic": "N/A",
                "message": "can-not entertain social domains right now",
                "status_code": 406,
            }
        
        else:
            non_social_domains.append(domain)

    try:
        scraped = {}
        
        if non_social_domains:
            scraped = await browser_manager.scrape_domains_in_parallel(non_social_domains)

        results_dict = {**social_skipped, **scraped}

        results = []
        for domain in results_dict:
            r = results_dict.get(domain, {})
            
            results.append({
                "domain": domain,
                "data": {
                    "domain_rating": r.get("domain_rating"),
                    "url_rating": r.get("url_rating"),
                    "organic_traffic": r.get("organic_traffic"),
                    "message": r.get("message"),
                    "status_code": r.get("status_code"),
                },
            })

        elapsed = time.time() - start_time
        ok = sum(1 for r in results if r["data"]["status_code"] == 200)
        failed = [r for r in results if r["data"]["status_code"] != 200]

        log(f"OUT /drur: {ok}/{len(results)} ok in {elapsed:.2f}s")
        for r in failed:
            log(f"     fail {r['domain']}: {r['data']['status_code']} - {r['data']['message']}")

        return {"results": results}

    except Exception as e:
        log(f"ERROR /drur: {type(e).__name__} - {e}")
        
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "execution_time": time.time() - start_time},
        )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
