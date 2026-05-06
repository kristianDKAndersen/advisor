#!/usr/bin/env python3
"""Browser daemon — aiohttp UNIX socket server backed by a CDP connection to Chrome."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
from pathlib import Path

# Ensure lib/ is importable
_repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_repo))

import aiohttp
from aiohttp import web
from cdp_use import CDPClient

from lib.browser import actions as act
from lib.browser.session import write_state, update_last_action

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("daemon")


class BrowserDaemon:
    def __init__(self, session_id: str, cdp_url: str, socket_path: str,
                 session_dir: Path, output_dir: Path | None = None):
        self.session_id = session_id
        self.cdp_url = cdp_url
        self.socket_path = socket_path
        self.session_dir = session_dir
        self.output_dir = output_dir
        self.client: CDPClient | None = None
        self.selector_map: dict[int, dict] = {}
        self.done_flag: dict = {"is_done": False}
        self._stop_event: asyncio.Event | None = None
        self.app = web.Application()
        self.runner: web.AppRunner | None = None

    async def start(self):
        log.info(f"Connecting to Chrome: {self.cdp_url}")
        self.client = CDPClient(self.cdp_url)
        await self.client.start()
        log.info("CDP connection established")

        # Enable Page domain for navigation events
        await self.client.send_raw("Page.enable", {})

        self.app.router.add_get("/state", self.handle_state)
        self.app.router.add_post("/act", self.handle_act)
        self.app.router.add_post("/shutdown", self.handle_shutdown)

        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        site = web.UnixSite(self.runner, self.socket_path)
        await site.start()
        log.info(f"Daemon listening on {self.socket_path}")

    async def stop(self):
        if self.runner:
            await self.runner.cleanup()
        if self.client:
            await self.client.stop()
        sock = Path(self.socket_path)
        if sock.exists():
            sock.unlink(missing_ok=True)

    async def handle_state(self, request: web.Request) -> web.Response:
        try:
            state = await act.get_state(
                self.client, self.session_dir, self.selector_map,
                set(self.selector_map.keys()) if self.selector_map else None,
            )
            update_last_action(self.session_id)
            return web.json_response({"ok": True, **state})
        except Exception as e:
            log.exception("get_state failed")
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    async def handle_act(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

        action = body.get("action", "")
        params = body.get("params", {})
        log.info(f"action={action} params={params}")

        try:
            result = await self._dispatch(action, params)
            update_last_action(self.session_id)
            return web.json_response({"ok": True, "result": result})
        except Exception as e:
            log.exception(f"action {action} failed")
            return web.json_response({"ok": False, "error": str(e)})

    async def handle_shutdown(self, request: web.Request) -> web.Response:
        log.info("Shutdown requested")
        stop_event = getattr(self, "_stop_event", None)
        if stop_event:
            stop_event.set()
        return web.json_response({"ok": True})

    async def _dispatch(self, action: str, params: dict):
        c = self.client
        sd = self.session_dir
        od = self.output_dir
        sm = self.selector_map

        if action == "navigate":
            return await act.navigate(c, params, sd)
        elif action == "click_index":
            return await act.click_index(c, params, sm)
        elif action == "input_text":
            return await act.input_text(c, params, sm)
        elif action == "scroll":
            return await act.scroll(c, params)
        elif action == "extract":
            return await act.extract(c, params)
        elif action == "screenshot":
            return await act.screenshot(c, params, sd, od)
        elif action == "get_state":
            return await act.get_state(c, sd, sm, set(sm.keys()) if sm else None)
        elif action == "done":
            return await act.done(c, params, self.done_flag)
        elif action == "wait":
            return await act.wait(c, params)
        elif action == "search":
            return await act.search(c, params, sd)
        else:
            raise ValueError(f"unknown action: {action}")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--cdp-url", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--output-dir", default=None)
    args = parser.parse_args()

    session_dir = Path.home() / ".advisor" / "browser-sessions" / args.session
    output_dir = Path(args.output_dir) if args.output_dir else None

    daemon = BrowserDaemon(
        session_id=args.session,
        cdp_url=args.cdp_url,
        socket_path=args.socket,
        session_dir=session_dir,
        output_dir=output_dir,
    )

    stop_event = asyncio.Event()

    def _shutdown(*_):
        log.info("Signal received, shutting down")
        asyncio.get_event_loop().call_soon_threadsafe(stop_event.set)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    daemon._stop_event = stop_event
    await daemon.start()

    try:
        await stop_event.wait()
    finally:
        await daemon.stop()
        log.info("Daemon stopped")


if __name__ == "__main__":
    asyncio.run(main())
