"""Cloud Run entrypoint: uvicorn serving the FastAPI app (app.py).

One long-lived event loop for the whole process — the wayfinder-paths SDK
holds module-level httpx.AsyncClient singletons that bind to the loop they
first run on, and background strategy jobs (asyncio.create_task) outlive
their originating request. Keep Cloud Run CPU always allocated so those
jobs aren't throttled after the response is sent.
"""

import os

import uvicorn


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, workers=1)


if __name__ == "__main__":
    main()
