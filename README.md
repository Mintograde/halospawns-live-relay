# HaloSpawns Live Relay

Websocket server in a Cloudflare worker for the live game spectating feature on halospawns.com

## Install
```
npm i -g wrangler
wrangler login
```

## Test Locally
```
wrangler dev --env dev
```
Local WS origin: `ws://127.0.0.1:8787`

## Secrets
Set the API HMAC secret separately for each deployed environment:
```
wrangler secret put APP_API_HMAC_SECRET --env dev
wrangler secret put APP_API_HMAC_SECRET --env prod
```

## Deploy
```
wrangler deploy --env dev
wrangler deploy --env prod
```

The `dev` and `prod` environments deploy as separate Workers with separate Durable Object storage.

## Endpoints
- `WS /ws/:roomId` -> one producer per room, enforced by key returned from initial producer connection
- `HTTP GET /rooms/:roomId/info` -> room and connection stats

## Examples
- Producer:
  - `pip install websockets`
  - `python examples/producer.py --room demo-room`
- Consumer:
  - Open `examples/consumer.html` in a browser
  - Host: `ws://127.0.0.1:8787`, Room: demo-room
