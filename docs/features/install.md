# Install

The app is an Even Hub app: a web page packed as an `.ehpk` and
installed through the Even Hub developer portal, or run from a
development server while developing.

## The hub

The hub must be reachable over HTTPS from the phone and answer CORS
preflights for bearer-token clients, which protocol v1 includes. Make a
token for the glasses on the hub:

```sh
muxway hub token create --name glasses --read 'alice-laptop/*' --write 'alice-laptop/@build'
```

## Pack with your hub

The Even app lets an app reach only the hosts its manifest names, so the
package carries your hub's origin:

```sh
npm ci
scripts/pack.sh https://hub.example.com com.example.muxway muxway.ehpk
```

The committed `app.json` names `https://hub.example.com` and a
placeholder package id; `pack.sh` writes yours into a copy and packs
`dist/`. Upload the `.ehpk` in the Even Hub developer portal as a **beta**
build with yourself as the tester and install it from the Even app's
beta section: a beta install behaves like a released app and survives
the phone lock, which a private build does not. Open the app once on the
phone, set the hub URL and paste the token on the [phone
pane](phone-pane.md).

## Develop

```sh
npm run dev                              # Vite on 127.0.0.1:5173
npm run simulate                         # the Even Hub simulator on that page, automation port 9898
```

The simulator needs `libwebkit2gtk-4.1-0` on Linux. On the real glasses
the Even app's developer section runs a page from a URL: serve the dev
server through HTTPS on a host you own and scan the code `npx evenhub
qr --url https://dev.example.com/` prints. The token is then typed on the
phone pane, once.

## Security considerations

- The manifest's whitelist is the Even app's own guard: the packed app
  cannot reach any host but your hub. Its `g2-microphone` permission is
  for [spoken replies](spoken-replies.md); the mic opens on that action
  only.
- A development page is served over HTTPS as well; the hub URL rules
  refuse plain `http` beyond loopback.
- The package holds no token and no hub of the author's: both are set on
  the phone.
