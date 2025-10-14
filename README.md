# HaloSpawns Live Relay

A Cloudflare worker websocket relay, supporting the live spectating features of halospawns.com.

## Install
```
npm i -g wrangler
wrangler login
```

## Test Locally
```
wrangler dev
```
Local WS origin: ws://127.0.0.1:8787

## Deploy
```
wrangler deploy
```

## Endpoints
- `WS /ws/:roomId` -> one producer per room, enforced by key returned from initial producer connection
- `HTTP GET /rooms/:roomId/info` -> room and connection stats

## Examples
- Producer:
  - pip install websockets
  - python examples/producer.py --room demo-room
- Consumer:
  - Open examples/consumer.html in a browser
  - Host: ws://127.0.0.1:8787, Room: demo-room
