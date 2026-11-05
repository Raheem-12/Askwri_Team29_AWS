"""Web protections for the FastAPI app: security headers, host checks, size and rate limits.

Settings: ALLOWED_HOSTS (comma separated), RATE_LIMIT_PER_MINUTE. Rate limits are per client address
and per process, so a deployment behind a load balancer needs its own limit at the edge as well.
"""
import base64
import hashlib
import os
import re
import threading
import time
from collections import defaultdict, deque

from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

MAX_BODY_BYTES = 64 * 1024  # six turns of history at their field limits, with room for JSON escapes
COSTLY_ROUTES = ('/api/ask', '/api/glance', '/api/briefing')  # each one spends Bedrock tokens
WINDOW_SECONDS = 60
BASE_POLICY = ("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
               "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
HEADERS = {'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
           'Cross-Origin-Opener-Policy': 'same-origin',
           'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'}


def allowed_hosts():
    # An explicit list stops DNS rebinding, where a website reaches this local server under its own name.
    return [h.strip() for h in os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver').split(',') if h.strip()]


def rate_limit():
    try:
        return max(1, int(os.getenv('RATE_LIMIT_PER_MINUTE', '30')))
    except ValueError:
        return 30


class RateLimiter:
    def __init__(self):
        self.hits, self.lock = defaultdict(deque), threading.Lock()

    def retry_after(self, client, limit, now=None):
        """Seconds to wait if this request is over the limit, otherwise None (and it is counted)."""
        now = time.monotonic() if now is None else now
        with self.lock:
            for key in [k for k, v in self.hits.items() if not v or v[-1] <= now - WINDOW_SECONDS]:
                del self.hits[key]  # keeps memory bounded when many addresses pass through
            hits = self.hits[client]
            while hits and hits[0] <= now - WINDOW_SECONDS:
                hits.popleft()
            if len(hits) >= limit:
                return max(1, int(hits[0] + WINDOW_SECONDS - now) + 1)
            hits.append(now)
            return None

    def reset(self):
        with self.lock:
            self.hits.clear()


limiter = RateLimiter()


def page_policy(radar_html):
    """The Radar page is one file with an inline script. A hash allows that script and no other."""
    match = re.search(r'<script>(.*?)</script>', radar_html, re.S)
    digest = base64.b64encode(hashlib.sha256(match.group(1).encode('utf-8')).digest()).decode() if match else ''
    return f"script-src 'sha256-{digest}'; " + BASE_POLICY


def install(app, radar_file):
    radar_policy = page_policy(radar_file.read_text(encoding='utf-8'))
    default_policy = "script-src 'self'; " + BASE_POLICY

    @app.middleware('http')
    async def protect(request, call_next):
        path, response = request.url.path, None
        if request.method == 'POST':
            try:
                size = int(request.headers.get('content-length', ''))
            except ValueError:
                response = JSONResponse({'detail': 'A request size is required.'}, status_code=411)
            else:
                if size > MAX_BODY_BYTES:
                    response = JSONResponse({'detail': 'That request is too large.'}, status_code=413)
            if response is None and path in COSTLY_ROUTES:
                client = request.client.host if request.client else 'unknown'
                wait = limiter.retry_after(client, rate_limit())
                if wait:
                    response = JSONResponse({'detail': f'Too many requests. Please wait {wait} seconds and try again.'},
                                            status_code=429, headers={'Retry-After': str(wait)})
        if response is None:
            response = await call_next(request)
        for name, value in HEADERS.items():
            response.headers[name] = value
        response.headers['Content-Security-Policy'] = radar_policy if path == '/radar' else default_policy
        if path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'  # answers can quote a masked question
        return response

    # Added last so it runs first: a request for an unknown host goes no further.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts())
