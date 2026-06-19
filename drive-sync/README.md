# GMVMAX Google Drive Storage

Primary archive:

https://docs.google.com/spreadsheets/d/1PNWc0N3KniTqkHC1nyWXYsKcXv7OI88ix8Mj1CLb86E

## Current Storage Policy

- Google Drive is the primary archive and read source for analysis snapshots.
- Local `logs/` files are retained as capture buffer only.
- Current ChatGPT Google Drive connector can create/import/read Google Workspace files, but it is not a callable API from the background Node monitor.
- Do not disable local JSONL writes until a service-account/OAuth Drive writer or raw upload endpoint is configured for the monitor process.

## Synced Tabs

- `Index`
- `Decision Snapshots`
- `Page Snapshots`
- `Network Family Summary`
- `Network Key Summary`
- `Network Lane Hits`
- `Allocation Campaign Mix`
- `Allocation Correlations`
- `Allocation Models`
- `Local Raw Manifest`
- `Material Records Sample`

## Raw Data Status

Large raw JSONL logs are summarized in Google Sheets. Full raw JSONL upload is blocked by the currently exposed Drive connector because no raw-file upload/folder tool is available in this session. Existing raw files are staged locally under `drive-sync/gmvmax-archive-2026-06-05/` for future upload when a raw Drive upload method is available.

## Safe Next Step To Remove Local Persistence

Configure one of:

1. A Google Drive API service account/OAuth credential available to the Node monitor.
2. A Drive Apps Script Web App endpoint that accepts append-only JSONL chunks.
3. A mounted Drive filesystem folder with verified write consistency.

After that, `logs/` can be moved to a temporary spool and automatically deleted only after successful remote commit confirmation.
