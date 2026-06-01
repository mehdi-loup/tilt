"""Cloud Run entrypoint for the Wayfinder sidecar.

`execute.py` defines a `BaseHTTPRequestHandler` (`handler`) for Vercel's Python
runtime. The wayfinder-paths dependency tree (web3, pandas, ccxt, matplotlib …)
is too large for a Vercel serverless function, so the sidecar runs here on Cloud
Run instead; the Next.js app reaches it via WAYFINDER_SIDECAR_URL.

Cloud Run sends concurrent requests, so we use a threading server. Each request
handler runs its own asyncio loop (execute.py uses asyncio.run per request).
"""

import os
from http.server import ThreadingHTTPServer

from execute import handler


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"wayfinder sidecar listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
