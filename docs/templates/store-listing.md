# Store listing: <app name>

> Copy this file to `docs/store-listing.md` and fill it in before the
> first submission to the Even Hub developer portal; update the
> changelog and the counts for every version after. Everything the
> portal asks for, ready to paste, in its order. Nothing here names a
> real host, person or key: those are typed into the portal.

## 1. Before you pack

| What | Where | Why |
|---|---|---|
| the `network` whitelist | `app.json` | the Even app lets the page reach only the hosts named here; the pack script writes the operator's own host in |
| the `package_id` | `app.json` | changing it after the first submission makes a new app and orphans the listing and its beta group |

```sh
scripts/pack.sh https://<your host> <package id> <name>.ehpk
```

## 2. Manifest values

| Field | Value | Limit |
|---|---|---|
| `package_id` | | reverse-domain, lowercase, three segments |
| `name` | | at most 20 characters, not containing "Even" |
| `version` | | three-part semver, no suffix; a new version for every submission |
| `edition` | `202601` | exact |
| `min_sdk_version` | | the SDK the page is built against |
| `min_app_version` | | stamped by `evenhub pack` from the SDK |
| `entrypoint` | `index.html` | present in `dist/` |
| `supported_languages` | | |

## 3. Listing copy

**Name**: `<name>`

**Tagline** (n / 50 characters)

```
```

**Description** (n / 2000 characters)

```
```

**Changelog** (required for every version)

```
```

**Category**: <category>

## 4. Permission justifications

One per permission in `app.json`, the same text as its `desc`; the
reviewer compares it with what the app does and refuses a permission
that goes unused.

- **network**:
- **<other>**:

## 5. Backend domains

The hosts the app talks to, documented and traceable to the operator:

- **<role>**: <who runs it, what it does, what it terminates>
- **No other outbound host**: no analytics, no CDN, no font or script
  fetched at run time.

## 6. Reviewer access

A reviewer without a backend sees an unconfigured app, which reads as a
broken first run. Give them a throwaway backend with synthetic data and
say so in the notes:

```
Setup: ...
Gestures: ...
The backend above serves synthetic data only; no real machine is reachable through it.
```

Keep it up until the review clears.

## 7. Screenshots

Taken from the simulator against the test environment, so they match
the device and show nothing real. 576 x 288 PNG for the glasses.

| File | Shows |
|---|---|
| `store/shots/01-....png` | |

Pick five to eight for the listing.

## 8. Icon

Drawn, greyscale only, no colour, no noise.

| File | Size | Format | Use |
|---|---|---|---|
| `public/icon.png` | 24 x 24 | 8-bit grey | inside the package |
| `store/icon-512-foreground.png` | 512 x 512 | grey with alpha | portal foreground |
| `store/icon-512-background.png` | 512 x 512 | 8-bit grey | portal background |
| `store/icon-512.png` | 512 x 512 | 8-bit grey | flattened |

## 9. QA self-check

| Check | Where it stands |
|---|---|
| no black screen on launch; setup explained | |
| settings persist | |
| five-minute locked-phone test | test on a beta install; it fails most often |
| root double tap exits | |
| responsive after two minutes idle | |
| CORS on the backend | |
| no unused permission | |
| content safety | |

## 10. Sources

- App Submission & QA Guidelines (hub.evenrealities.com/docs/reference/app-submission)
- Beta Testing (hub.evenrealities.com/docs/test/beta-testing)
