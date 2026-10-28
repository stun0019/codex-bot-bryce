"""Local API and website host for the observation scanner."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .scanner import Observer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
observer = Observer()


async def scan_loop() -> None:
    interval = max(30, int(os.getenv("CODEX_SCAN_SECONDS", "60")))
    while True:
        try:
            count = await asyncio.to_thread(observer.scan_once)
            logger.info("Observation scan finished; new candidates=%s", count)
        except Exception:
            logger.exception("Observation scan failed")
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(scan_loop())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Codex Bot Observer", lifespan=lifespan)


@app.get("/api/observer/status")
def status() -> dict:
    return observer.status()


@app.get("/api/observer/candidates")
def candidates() -> list[dict]:
    return observer.candidates()


SITE = Path(__file__).resolve().parents[2] / "site"
app.mount("/", StaticFiles(directory=SITE, html=True), name="site")
