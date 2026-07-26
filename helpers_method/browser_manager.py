import os
import re
import json
import time
import socket
import random
import asyncio
from typing import Dict
from urllib.parse import urlparse
from playwright.async_api import async_playwright, Page
from helpers_method.constants import MAX_PARALLEL, BROWSER_CHANNEL
from helpers_method.constants import BAR_USERNAME, BAR_PASSWORD, BAR_API_BASE
from helpers_method.constants import PROFILE_NAME, EXTENSION_PATH, BAR_SESSION_FILE
from helpers_method.constants import INACTIVE_FAILED_HTML_KEYWORDS, INACTIVE_FAILED_HTML_DISPLAY_MAP

class BrowserManager:
    def __init__(self):
        self._is_shutting_down = False
        self.single_domain_attempts = 3
        self._focus_lock = asyncio.Lock()
        
        self._shutdown_lock = asyncio.Lock()
        self.context = self.playwright = None
        
        self.single_domain_attempt_timeout_s = 7.0
        self.page = self.ext_id = self.browser = None
        self._semaphore = asyncio.Semaphore(MAX_PARALLEL)


    @staticmethod
    def _is_target_closed_error(e: Exception) -> bool:
        m = str(e)
        return ("Target page" in m) or ("Target closed" in m) or ("TargetClosedError" in m)

    @staticmethod
    async def safe_close_page(page: Page) -> None:
        if page is None:
            return
        
        try:
            if not page.is_closed():
                await page.close()
        
        except Exception:
            pass

    @staticmethod
    def random_delay(min_ms: int, max_ms: int) -> int:
        return random.randint(min_ms, max_ms)

    def normalize_domain(self, domain: str) -> str:
        parsed = urlparse(domain if domain.startswith("http") else f"http://{domain}")
        return parsed.netloc.replace("www.", "") or parsed.path.replace("www.", "")

    def empty_metrics(self):
        return {
            "url_rating": "N/A",
            "domain_rating": "N/A",
            "organic_traffic": "N/A",
            "status_code": None,
            "message": "N/A",
        }

    async def start(self):
        if self.playwright is not None:
            return

        self.playwright = await async_playwright().start()

        launch_kwargs = dict(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled", "--start-maximized",
                f"--disable-extensions-except={EXTENSION_PATH}",
                f"--load-extension={EXTENSION_PATH}",
            ],
            
            ignore_https_errors=True,
            viewport={"width": 1360, "height": 850},
            locale="en-US",
        )
        
        if BROWSER_CHANNEL:
            launch_kwargs["channel"] = BROWSER_CHANNEL

        self.context = await self.playwright.chromium.launch_persistent_context(
            f"./{PROFILE_NAME}", **launch_kwargs
        )
        
        self.browser = self.context.browser

        await self.context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        await self._resolve_ext_id()
        await self.ensure_login()

    async def shutdown_browser(self):
        async with self._shutdown_lock:
            self._is_shutting_down = True
            
            try:
                if self.context:
                    await self.context.close()
            except Exception:
                pass
            
            finally:
                self.page = None
                self.context = None
                self.browser = None

            try:
                if self.playwright:
                    await self.playwright.stop()
            except Exception:
                pass
            
            finally:
                self.playwright = None
                self._is_shutting_down = False

    async def ensure_browser_alive(self):
        if self._is_shutting_down:
            raise Exception("Browser is shutting down")
        
        if self.browser is None or self.browser.is_connected() is False:
            await self.shutdown_browser()
            self.playwright = None
            await self.start()

    async def _resolve_ext_id(self):
        sw = None
        for _ in range(20):
            if self.context.service_workers:
                sw = self.context.service_workers[0]
                break
            
            try:
                sw = await self.context.wait_for_event("serviceworker", timeout=3000)
                break
            except Exception:
                await asyncio.sleep(0.5)
        
        self.ext_id = sw.url.split("/")[2] if sw else None
        print(f"bar extension id: {self.ext_id}")

    def _read_stored_token(self):
        try:
            with open(BAR_SESSION_FILE, "r", encoding="utf-8") as f:
                return (json.load(f) or {}).get("tm_session_token")
        
        except Exception:
            return None

    def _write_stored_token(self, token):
        try:
            with open(BAR_SESSION_FILE, "w", encoding="utf-8") as f:
                json.dump({"tm_session_token": token}, f)
        
        except Exception as e:
            print(f"could not persist bar session: {e}")

    def _clear_stored_token(self):
        try:
            if os.path.exists(BAR_SESSION_FILE):
                os.remove(BAR_SESSION_FILE)
        
        except Exception:
            pass

    async def _logout_stale_session(self):
        token = self._read_stored_token()
        
        if not token:
            return
        
        try:
            await self.context.request.post(
                f"{BAR_API_BASE}/logout.php",
                data=json.dumps({"session_token": token}),
                headers={"Content-Type": "application/json"},
                timeout=15000,
            )
            
            print("freed stale bar session from previous run")
        
        except Exception as e:
            print(f"stale logout skipped: {e}")
        
        self._clear_stored_token()

    async def _popup_logged_in(self, popup: Page) -> bool:
        try:
            return await popup.evaluate(
                "() => { const el = document.getElementById('ah_p'); return !!el && getComputedStyle(el).display !== 'none'; }"
            )
        
        except Exception:
            return False

    async def _await_login_result(self, popup: Page):
        for _ in range(20):
            await asyncio.sleep(1.5)
            
            state = await popup.evaluate(
                """() => {
                    const vis = el => el && getComputedStyle(el).display !== 'none';
                    const msg = document.getElementById('login-message');
                    return { main: vis(document.getElementById('ah_p')),
                             msg: (msg && vis(msg)) ? msg.textContent.trim() : null };
                }"""
            )
            
            if state["main"]:
                return True, "ok"
            
            if state["msg"]:
                return False, state["msg"]
        
        return False, "login timed out"

    async def _persist_session(self, popup: Page):
        try:
            token = await popup.evaluate(
                "() => new Promise(r => chrome.storage.local.get(['tm_session_token'], x => r(x.tm_session_token || null)))"
            )
            
            if token:
                self._write_stored_token(token)
        
        except Exception:
            pass

    async def ensure_login(self):
        if not self.ext_id:
            print("warning: extension id not resolved; bar cannot authenticate")
            return

        popup = await self.context.new_page()
        
        try:
            await popup.goto(f"chrome-extension://{self.ext_id}/popup.html", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)

            if await self._popup_logged_in(popup):
                print("bar session reused - login skipped")
                await self._persist_session(popup)
                return

            await self._logout_stale_session()

            await popup.fill("#login-username", BAR_USERNAME or "")
            await popup.fill("#login-password", BAR_PASSWORD or "")
            await popup.click("#login-btn")

            ok, msg = await self._await_login_result(popup)
            
            if ok:
                print("bar login OK")
                await self._persist_session(popup)
            
            else:
                print(f"BAR LOGIN FAILED: {msg}")
                if "already active" in msg.lower() or "device" in msg.lower():
                    print("=> logout the bar session in your own browser once, then restart this tool.")
        
        finally:
            await self.safe_close_page(popup)

    async def _domain_resolves(self, domain: str) -> bool:
        host = self.normalize_domain(domain)
        
        if not host:
            return False
        
        loop = asyncio.get_event_loop()
        candidates = [host] if host.startswith("www.") else [host, f"www.{host}"]
        
        for candidate in candidates:
            try:
                await asyncio.wait_for(
                    loop.run_in_executor(None, socket.getaddrinfo, candidate, None),
                    timeout=5.0,
                )
                return True
            
            except asyncio.TimeoutError:
                return True
            
            except Exception:
                continue
        
        return False

    async def scrape_domains_in_parallel(self, domains):
        await self.ensure_browser_alive()
        
        if not self.context:
            raise Exception("Browser context not available")

        tasks = [self.scrape_single_domain_tab(domain) for domain in domains]
        results = await asyncio.gather(*tasks)
        return {domain: metrics for domain, metrics in results}

    async def scrape_single_domain_tab(self, domain: str):
        metrics = self.empty_metrics()

        if not await self._domain_resolves(domain):
            metrics["status_code"] = 400
            metrics["message"] = "Invalid domain (DNS resolution failed)"
            return domain, metrics

        async with self._semaphore:
            page = await self.context.new_page()
            deadline = time.monotonic() + 19.5

            for attempt in range(1, self.single_domain_attempts + 1):
                try:
                    await self._process_single_tab(page, domain, metrics, has_retried=False, deadline=deadline)
                    break

                except asyncio.TimeoutError:
                    await self.safe_close_page(page)
                    
                    if attempt < self.single_domain_attempts and time.monotonic() < deadline:
                        page = await self.context.new_page()
                        continue
                    
                    if metrics.get("status_code") != 503:
                        metrics["status_code"] = 408
                        metrics["message"] = "Ahrefs bar not loaded within time limit"
                        metrics["domain_rating"], metrics["url_rating"], metrics["organic_traffic"] = "N/A", "N/A", "N/A"
                    
                    break

                except Exception as e:
                    if self._is_target_closed_error(e) and attempt < self.single_domain_attempts and self.context:
                        if time.monotonic() < deadline:
                            await self.safe_close_page(page)
                            page = await self.context.new_page()
                            continue
                    
                    metrics["status_code"], metrics["message"] = 500, f"{str(e)}"
                    metrics["domain_rating"], metrics["url_rating"], metrics["organic_traffic"] = "N/A", "N/A", "N/A"
                    break

                finally:
                    await self.safe_close_page(page)

        return domain, metrics

    async def _process_single_tab(self, page: Page, domain: str, metrics: Dict[str, str], has_retried: bool = False, deadline: float = None):
        try:
            if page.is_closed():
                raise Exception("Target page, context or browser has been closed")

            await page.route(
                "**/*",
                lambda route: route.abort()
                if route.request.resource_type in ("image", "font", "media")
                else route.continue_(),
            )

            try:
                domain = self.normalize_domain(domain)
                r_ms = int(self.single_domain_attempt_timeout_s * 1000)
                
                if deadline:
                    r_ms = min(r_ms, max(1, int((deadline - time.monotonic()) * 1000)))
                
                await page.goto(f"https://{domain}", wait_until="domcontentloaded", timeout=r_ms)

            except Exception:
                await self.safe_close_page(page)
                await asyncio.sleep(0.25)
                new_page = await self.context.new_page()
                
                try:
                    r_ms = int(self.single_domain_attempt_timeout_s * 1000)
                    
                    if deadline:
                        r_ms = min(r_ms, max(1, int((deadline - time.monotonic()) * 1000)))
                    
                    await new_page.goto(f"http://{domain}", wait_until="domcontentloaded", timeout=r_ms)
                
                except Exception:
                    await self.safe_close_page(new_page)
                    raise
                
                page = new_page

            html_response = await page.content()
            match = re.search(r"<body[^>]*>(.*?)</body>", html_response, re.DOTALL | re.IGNORECASE)
            body_content = match.group(1).strip() if match else ""

            if not body_content:
                await self.safe_close_page(page)
                metrics["status_code"], metrics["message"] = 502, "Site not reachable"
                metrics["domain_rating"], metrics["url_rating"], metrics["organic_traffic"] = "N/A", "N/A", "N/A"
                return

            html_lower = html_response.lower()
            found_inactive = [kw for kw in INACTIVE_FAILED_HTML_KEYWORDS if kw in html_lower]
            
            if found_inactive:
                await self.safe_close_page(page)
                metrics["status_code"] = 502
                
                metrics["message"] = "; ".join(
                    INACTIVE_FAILED_HTML_DISPLAY_MAP[kw] for kw in found_inactive if kw in INACTIVE_FAILED_HTML_DISPLAY_MAP
                )
                
                metrics["domain_rating"], metrics["url_rating"], metrics["organic_traffic"] = "N/A", "N/A", "N/A"
                return

            async with self._focus_lock:
                if page.is_closed():
                    raise Exception("Target page, context or browser has been closed")

                r_ms = int(self.single_domain_attempt_timeout_s * 1000)
                if deadline:
                    r_ms = min(r_ms, max(1, int((deadline - time.monotonic()) * 1000)))

                if not await page.query_selector("div.ah_barstats-wrapper"):
                    await page.bring_to_front()
                    await asyncio.sleep(0.05)
                    await page.wait_for_selector("div.ah_barstats-wrapper", timeout=r_ms)

                selector = lambda c: f"xpath=//span[translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='{c}']/following-sibling::span[1]"
                dr_selector, ur_selector, st_selector = map(selector, ("dr", "ur", "st"))

                if await page.query_selector(dr_selector):
                    metrics["domain_rating"] = (await page.inner_text(dr_selector)).strip()
                
                if await page.query_selector(ur_selector):
                    metrics["url_rating"] = (await page.inner_text(ur_selector)).strip()
                
                if await page.query_selector(st_selector):
                    metrics["organic_traffic"] = (await page.inner_text(st_selector)).strip()

            if metrics["domain_rating"] == "N/A" and metrics["url_rating"] == "N/A":
                rendered_lower = (await page.content()).lower()
                found_inactive = [kw for kw in INACTIVE_FAILED_HTML_KEYWORDS if kw in rendered_lower]
                
                if found_inactive:
                    metrics["message"] = "; ".join(
                        INACTIVE_FAILED_HTML_DISPLAY_MAP[kw] for kw in found_inactive if kw in INACTIVE_FAILED_HTML_DISPLAY_MAP
                    )
                    
                    metrics["domain_rating"], metrics["url_rating"], metrics["organic_traffic"] = "N/A", "N/A", "N/A"
                    
                    if "error fetching data" in found_inactive:
                        metrics["status_code"] = 503
                        raise asyncio.TimeoutError()
                    
                    await self.safe_close_page(page)
                    metrics["status_code"] = 502
                    return

            await self.safe_close_page(page)
            metrics["status_code"], metrics["message"] = 200, "success"

        except Exception as e:
            clean_domain = re.sub(r"^https?://", "", domain, flags=re.IGNORECASE).rstrip("/")
            
            if not clean_domain.startswith("www."):
                clean_domain = f"www.{clean_domain}"
            
            retry_domain = clean_domain

            if retry_domain != domain and not has_retried:
                await self.safe_close_page(page)
                new_page = await page.context.new_page()
                
                try:
                    return await self._process_single_tab(new_page, retry_domain, metrics, has_retried=True, deadline=deadline)
                finally:
                    await self.safe_close_page(new_page)

            if self._is_target_closed_error(e):
                await self.safe_close_page(page)
                raise
            
            if "TimeoutError" in type(e).__name__:
                await self.safe_close_page(page)
                raise asyncio.TimeoutError()

            await self.safe_close_page(page)
            metrics["status_code"], metrics["message"] = 502, "Site not reachable"
            metrics["domain_rating"], metrics["url_rating"], metrics["organic_traffic"] = "N/A", "N/A", "N/A"
