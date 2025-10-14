# Sends periodic JSON messages to durable objects room.
# Usage:
#   pip install websockets
#   python producer.py --room test-room
# Options:
#   --host ws://127.0.0.1:8787    # worker address, defaults to local wrangler dev
#   --interval 1.0                # seconds between messages
#   --stdin                       # send lines typed on stdin instead of periodic messages
#   --preempt-key KEY             # Authorization: Bearer KEY to preempt an existing producer
#   --always-include-key          # include per-message key even if not required

import argparse
import asyncio
import json
import signal
import sys
import time
from urllib.parse import quote

import websockets

def now_ms():
    return int(time.time() * 1000)

async def recv_loop(ws, state):
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
            except Exception:
                print(f"[recv] {raw!r}")
                continue

            print(f"[recv] {msg}")

            if isinstance(msg, dict) and msg.get("type") == "error" and msg.get("code") == "BAD_KEY":
                state["require_key"] = True
                print("[info] Server requires per-message key. Will include it in subsequent messages.")
    except websockets.ConnectionClosed as e:
        print(f"[recv] connection closed: code={e.code} reason={e.reason}")
    except Exception as e:
        print(f"[recv] error: {e!r}")

async def send_periodic(ws, state, interval):
    i = 0
    try:
        while True:
            payload = {
                "type": "demo",
                "seq": i,
                "t": time.time(),
                "msg": f"hello #{i}",
            }
            if state.get("require_key") or state.get("always_include_key"):
                if state.get("producer_key"):
                    payload["key"] = state["producer_key"]
            await ws.send(json.dumps(payload))
            print(f"[send] {payload}")
            i += 1
            await asyncio.sleep(interval)
    except websockets.ConnectionClosed:
        pass

async def send_stdin(ws, state):
    loop = asyncio.get_running_loop()
    try:
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                await asyncio.sleep(0.05)
                continue
            line = line.rstrip("\n")
            try:
                payload = json.loads(line)
                if not isinstance(payload, dict):
                    payload = {"data": payload}
            except Exception:
                payload = {"text": line, "t": time.time()}
            if state.get("require_key") or state.get("always_include_key"):
                if state.get("producer_key"):
                    payload["key"] = state["producer_key"]
            await ws.send(json.dumps(payload))
            print(f"[send] {payload}")
    except websockets.ConnectionClosed:
        pass

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="ws://127.0.0.1:8787")
    ap.add_argument("--room", default="test-room")
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--stdin", action="store_true")
    ap.add_argument("--preempt-key", default=None)
    ap.add_argument("--always-include-key", action="store_true")
    args = ap.parse_args()

    uri = f"{args.host}/ws/{quote(args.room)}?role=producer"
    headers = {}
    if args.preempt_key:
        headers["Authorization"] = f"Bearer {args.preempt_key}"

    print(f"[info] connecting to {uri}")
    state = {
        "producer_key": None,
        "require_key": False,
        "always_include_key": args.always_include_key,
    }

    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            asyncio.get_event_loop().add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    async with websockets.connect(uri, additional_headers=headers, ping_interval=20, ping_timeout=20) as ws:
        raw = await ws.recv()
        try:
            welcome = json.loads(raw)
        except Exception:
            print(f"[warn] unexpected first message: {raw!r}")
            welcome = {}

        if welcome.get("type") == "welcome" and welcome.get("role") == "producer":
            state["producer_key"] = welcome.get("producerKey")
            expires_at = welcome.get("expiresAt")
            print(f"[info] welcome: key={state['producer_key']} expiresAt={expires_at}")
        else:
            print(f"[warn] no welcome or wrong role: {welcome}")

        recv_task = asyncio.create_task(recv_loop(ws, state))
        send_task = asyncio.create_task(send_stdin(ws, state) if args.stdin else send_periodic(ws, state, args.interval))

        await stop.wait()
        print("[info] shutting down...")
        send_task.cancel()
        recv_task.cancel()
        try:
            await asyncio.gather(send_task, recv_task, return_exceptions=True)
        finally:
            await ws.close(code=1000, reason="Client closing")

if __name__ == "__main__":
    asyncio.run(main())