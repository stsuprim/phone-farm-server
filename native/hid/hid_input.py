#!/usr/bin/env python3
"""Live touch for one iPhone through Apple's CoreDevice HID path (the one Xcode 27's Device Hub uses).

docs/BEST_METHOD.md, plan item 1: real down/move/up touch reports go straight to backboardd (no XCTest, no
WebDriverAgent), so a tap lands in a few ms and a drag is live. Needs iOS 27+ on the phone, Developer Mode, the
Developer Disk Image mounted (Xcode/WDA mount it) and pymobiledevice3 (`python3 -m pip install -U pymobiledevice3`).
No root: the tunnel is pymobiledevice3's userspace one (falls back to the native/remoted tunnel, then tunneld).

The server (src/hid.ts) runs one of these per phone and keeps it open while someone is viewing that phone.

stdin, one JSON object per line ({"id": n, "op": ...}):
  open                       tunnel + touch session (media-stream auth gate held open); idempotent
  close                      leave the touch session (frees the camera/mic, see BEST_METHOD.md)
  down / move / up  x y      one finger; x, y are 0..65535 across the portrait screen (0,0 = top left)
  tap   x y [hold_ms]        contact, hold (default 40 ms), release
  path  points [[x,y,ms]..]  a whole gesture with its timing (answered once queued)
  type  text                 printable ASCII, \\n and \\t, through a virtual HID keyboard (answered once queued)
  ping
stdout, one JSON object per line:
  {"id", "ok", "error"?, "ms"}             the answer: when the report is written (down/move/up/tap) or queued
  {"ev": "done", "id", "ok", "error"?, "ms"} a queued path/type finished
  {"ev": "hello", "version"} / {"ev": "open", "tsid", "ms"} / {"ev": "closed", "why"} / {"ev": "fatal", "error"}
`ms` is the time on this side from reading the line to the report written (receive -> injected).

--mock: no device, no pymobiledevice3; reports are only counted (for the server's tests).
"""
import argparse
import asyncio
import contextlib
import json
import os
import sys
import threading
import time

VERSION = 1
CONTACT = 0xC2
RELEASE = 0x02
MAIN_TOUCHSCREEN = 257


def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def now_ms():
    return time.perf_counter() * 1000.0


def clamp16(v):
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        raise ValueError("x and y must be numbers (0..65535)")
    return max(0, min(65535, n))


class MockHid:
    """Stands in for pymobiledevice3's UniversalHIDServiceService in --mock mode."""

    def __init__(self):
        self.reports = []

    async def send_touchscreen(self, state, x, y, service_id=MAIN_TOUCHSCREEN):
        self.reports.append((state, x, y))

    async def create_keyboard_service(self):
        return 1

    async def send_keyboard(self, service_id, usages=()):
        self.reports.append(("kb", tuple(usages)))


async def connect_rsd(udid):
    """A RemoteServiceDiscovery for the phone: userspace tunnel (no root), else macOS's own, else tunneld."""
    mode = os.environ.get("HID_TUNNEL", "auto").strip().lower()
    errors = []
    if mode in ("auto", "userspace"):
        try:
            from pymobiledevice3.remote import userspace_tunnel

            cls = getattr(userspace_tunnel, "UserspaceRsdTunnel", None)
            if cls is not None:
                try:
                    tunnel = cls(serial=udid, autopair=True, remotepairing_fallback=False)
                except TypeError:
                    tunnel = cls(serial=udid)
                rsd = await tunnel.aopen()
                return rsd, tunnel
            return await userspace_tunnel.establish_userspace_rsd(serial=udid), None
        except Exception as e:  # noqa: BLE001 - every failure is reported, then the next transport is tried
            errors.append(f"userspace tunnel: {e!r}")
    if mode in ("auto", "native") and sys.platform == "darwin":
        try:
            from pymobiledevice3.remote import native_tunnel

            return await native_tunnel.establish_native_rsd(serial=udid), None
        except Exception as e:  # noqa: BLE001
            errors.append(f"native tunnel: {e!r}")
    if mode in ("auto", "tunneld"):
        try:
            from pymobiledevice3.tunneld.api import get_tunneld_device_by_udid

            rsd = await get_tunneld_device_by_udid(udid)
            if rsd is not None:
                return rsd, None
            errors.append("tunneld: no tunnel for this phone")
        except Exception as e:  # noqa: BLE001
            errors.append(f"tunneld: {e!r}")
    raise RuntimeError("; ".join(errors) or f"unknown HID_TUNNEL={mode}")


class Phone:
    def __init__(self, udid, mock):
        self.udid = udid
        self.mock = mock
        self.rsd = None
        self.tunnel = None
        self.stack = None
        self.svc = None
        self.tsid = MAIN_TOUCHSCREEN
        self.kb = None
        self.last = None  # last contact point while a finger is down

    async def open(self):
        if self.svc is not None:
            return
        t0 = now_ms()
        if self.mock:
            self.svc = MockHid()
            out({"ev": "open", "tsid": self.tsid, "ms": round(now_ms() - t0, 1)})
            return
        from pymobiledevice3.remote.core_device.hid_service import touch_session

        if self.rsd is None:
            self.rsd, self.tunnel = await connect_rsd(self.udid)
        stack = contextlib.AsyncExitStack()
        try:
            svc = await stack.enter_async_context(touch_session(self.rsd))
            try:
                self.tsid = await asyncio.wait_for(svc.active_touchscreen_service_id(), 5)
            except Exception:  # noqa: BLE001 - older pymobiledevice3 or no display info: the main touchscreen
                self.tsid = MAIN_TOUCHSCREEN
        except BaseException:
            await stack.aclose()
            await self.drop_rsd()
            raise
        self.stack, self.svc, self.kb = stack, svc, None
        out({"ev": "open", "tsid": self.tsid, "ms": round(now_ms() - t0, 1)})

    async def drop_rsd(self):
        rsd, tunnel = self.rsd, self.tunnel
        self.rsd = self.tunnel = None
        with contextlib.suppress(Exception):
            if rsd is not None and hasattr(rsd, "close"):
                r = rsd.close()
                if asyncio.iscoroutine(r):
                    await r
        with contextlib.suppress(Exception):
            if tunnel is not None and hasattr(tunnel, "aclose"):
                await tunnel.aclose()

    async def close(self, why, drop_tunnel=False):
        stack = self.stack
        self.stack = self.svc = self.kb = None
        self.last = None
        if stack is not None:
            with contextlib.suppress(BaseException):
                await asyncio.wait_for(stack.aclose(), 5)
            out({"ev": "closed", "why": why})
        if drop_tunnel:
            await self.drop_rsd()

    async def report(self, state, x, y):
        await self.svc.send_touchscreen(state, x, y, service_id=self.tsid)

    async def down(self, x, y):
        if self.last is not None:  # a press while a finger is still down: lift it first
            await self.report(RELEASE, *self.last)
        await self.report(CONTACT, x, y)
        self.last = (x, y)

    async def move(self, x, y):
        if self.last is None:
            return  # a stray move with no finger down
        await self.report(CONTACT, x, y)
        self.last = (x, y)

    async def up(self, x, y):
        if self.last is None:
            return
        if (x, y) != self.last:
            await self.report(CONTACT, x, y)
        await self.report(RELEASE, x, y)
        self.last = None

    async def path(self, points):
        t0 = time.perf_counter()
        first = True
        for p in points:
            x, y = clamp16(p[0]), clamp16(p[1])
            at = max(0.0, float(p[2]) / 1000.0) if len(p) > 2 else 0.0
            wait = at - (time.perf_counter() - t0)
            if wait > 0:
                await asyncio.sleep(wait)
            if first:
                await self.down(x, y)
                first = False
            else:
                await self.move(x, y)
        if self.last is not None:
            await self.up(*self.last)

    async def type(self, text):
        if self.mock:
            ascii_to_hid, shift_key = {c: (ord(c), not c.islower()) for c in map(chr, range(0x20, 0x7F))}, 0xE1
            ascii_to_hid.update({"\n": (0x28, False), "\t": (0x2B, False)})
        else:
            from pymobiledevice3.remote.core_device.hid_service import ASCII_TO_HID as ascii_to_hid
            from pymobiledevice3.remote.core_device.hid_service import KEY_LEFT_SHIFT as shift_key
        if self.kb is None:
            self.kb = await self.svc.create_keyboard_service()
        for ch in text:
            mapping = ascii_to_hid.get(ch)
            if mapping is None:
                raise ValueError(f"unsupported character {ch!r}")
            usage, shift = mapping
            if shift:
                await self.svc.send_keyboard(self.kb, (shift_key,))
                await asyncio.sleep(0.02)
            await self.svc.send_keyboard(self.kb, (shift_key, usage) if shift else (usage,))
            await asyncio.sleep(0.02)
            await self.svc.send_keyboard(self.kb, ())
            await asyncio.sleep(0.01)


def check_ascii(text):
    for ch in text:
        if not (ch in "\n\t" or 0x20 <= ord(ch) <= 0x7E):
            raise ValueError(f"unsupported character {ch!r} (HID typing is printable ASCII only)")


async def queued(coro, answer):
    """Run an already-answered (queued) path/type; its outcome goes out as {"ev": "done"}."""
    try:
        await coro
        answer(ev="done")
    except ValueError as e:
        answer(False, str(e), ev="done")
    except Exception as e:  # noqa: BLE001 - the session is suspect: the caller's handler drops it
        answer(False, f"{type(e).__name__}: {e}", ev="done")
        raise Answered(e)


class Answered(Exception):
    """A failure whose answer already went out."""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--udid", required=True)
    ap.add_argument("--mock", action="store_true")
    args = ap.parse_args()
    for stream in (sys.stdin, sys.stdout):
        with contextlib.suppress(Exception):
            stream.reconfigure(encoding="utf-8")

    if not args.mock:
        try:
            import pymobiledevice3  # noqa: F401
            from pymobiledevice3.remote.core_device.hid_service import touch_session  # noqa: F401
        except Exception as e:  # noqa: BLE001
            out({"ev": "fatal", "error": f"pymobiledevice3 with core-device HID is not installed ({e!r}); "
                 "run: python3 -m pip install -U pymobiledevice3"})
            return 2

    phone = Phone(args.udid, args.mock)
    loop = asyncio.get_running_loop()
    lines = asyncio.Queue()

    def reader():  # a thread: portable (asyncio pipes differ per OS), and stdin EOF ends the process
        for line in sys.stdin:
            loop.call_soon_threadsafe(lines.put_nowait, line)
        loop.call_soon_threadsafe(lines.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()
    out({"ev": "hello", "version": VERSION, "mock": args.mock})

    while True:
        line = await lines.get()
        if line is None:
            break
        line = line.strip()
        if not line:
            continue
        t_recv = now_ms()
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict):
                raise ValueError("not an object")
        except ValueError:
            out({"id": None, "ok": False, "error": "bad JSON line"})
            continue
        mid = msg.get("id")
        op = msg.get("op")

        def answer(ok=True, error=None, ev=None):
            r = {"id": mid, "ok": ok, "ms": round(now_ms() - t_recv, 2)}
            if ev:
                r["ev"] = ev
                r["op"] = op
            if error:
                r["error"] = error
            out(r)

        try:
            if op == "quit":
                answer()
                break
            if op == "ping":
                answer()
                continue
            if op == "close":
                await phone.close("asked", drop_tunnel=bool(msg.get("tunnel")))
                answer()
                continue
            await phone.open()
            if op == "open":
                answer()
            elif op in ("down", "move", "up"):
                x, y = clamp16(msg.get("x")), clamp16(msg.get("y"))
                await getattr(phone, op)(x, y)
                answer()
            elif op == "tap":
                x, y = clamp16(msg.get("x")), clamp16(msg.get("y"))
                hold = min(2.0, max(0.0, float(msg.get("hold_ms") or 40) / 1000.0))
                await phone.down(x, y)
                answer()  # contact written: that's "injected"; the release follows
                await asyncio.sleep(hold)
                await phone.up(x, y)
            elif op == "path":
                pts = msg.get("points")
                if not isinstance(pts, list) or not pts or not all(isinstance(p, list) and len(p) >= 2 for p in pts):
                    raise ValueError('"points" must be [[x, y, ms], ...]')
                answer()
                await queued(phone.path(pts), answer)
            elif op == "type":
                text = msg.get("text")
                if not isinstance(text, str):
                    raise ValueError('"text" must be a string')
                check_ascii(text)
                answer()
                await queued(phone.type(text), answer)
            else:
                raise ValueError(f"unknown op {op!r}")
        except ValueError as e:
            answer(False, str(e))
        except Answered as e:
            await phone.close(f"error: {type(e.args[0]).__name__}", drop_tunnel=True)
        except Exception as e:  # noqa: BLE001 - the session is suspect: drop it, the next open makes a new one
            answer(False, f"{type(e).__name__}: {e}")
            await phone.close(f"error: {type(e).__name__}", drop_tunnel=True)

    await phone.close("exit", drop_tunnel=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
