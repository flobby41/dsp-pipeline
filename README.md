# dsp-pipeline

A production-grade music distribution pipeline — built to solve a real problem that killed artist trust.

> Originally architected at **Alter K Global Music Services** (Paris, 2022–2025),  
> where it handled thousands of artists and millions of tracks across Spotify, Apple Music, and Deezer.  
> This repo is a clean, portable rebuild of the core system.

**[Live demo →](https://dsp-pipeline.vercel.app/demo)**

---

## The problem

Artists would upload a large file — sometimes 200 MB — and nothing would happen.  
No error. No notification. Just silence.

Then came the support messages: *"my music isn't live."*  
And we had no idea why.

The root causes were three separate failures compounding each other:

- **Timeouts** — large files uploaded via a single HTTP request would time out mid-way, silently
- **No visibility** — when a DSP API was down, we had no retry logic and no error tracking
- **Scattered logic** — each platform's integration rules were tangled across the codebase, making debugging slow and changes risky

The system worked when we were small. It started cracking as volumes grew.

---

## The architecture decision

I faced a choice: patch the existing pipeline or redesign it properly.

Patching would have been faster short-term. But the failures were architectural — a series of point fixes would have just moved the problem around.

I chose to redesign, and split the system into three clean layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (browser)                        │
│              XHR multipart · chunk progress · ETag collection   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ POST /upload/init
                           │ PUT presignedUrl × N parts  ──────────► S3
                           │ POST /upload/complete
┌──────────────────────────▼──────────────────────────────────────┐
│                          API (Express)                          │
│         UploadService · DSPRegistry · webhooks · SSE            │
└──────────┬──────────────────────────────┬───────────────────────┘
           │ queue: track.process          │ GET /releases/:id/status
           │                              │ (Server-Sent Events)
┌──────────▼───────────────┐    ┌─────────▼────────┐
│      WORKER (BullMQ)     │    │     CLIENT UI    │
│  validate · encode       │    │  live DSP cards  │
│  spotify/apple/deezer    │    └──────────────────┘
│  retry × 3 · progress    │
└──────────────────────────┘
           │
           │ POST /webhooks/:dsp  (DSP confirms track live)
           ▼
   SpotifyAdapter  ──► retry logic · mapMetadata · POST /v1/releases
   AppleMusicAdapter ► mapMetadata · POST /api/releases
   DeezerAdapter ────► mapMetadata · POST /v2/tracks
```

**Layer 1 — S3 multipart upload**  
The file is split into 10 MB chunks, each uploaded in parallel via presigned URLs. The server never touches the bytes — it only orchestrates. This eliminated every timeout and made uploads resumable on interruption.

**Layer 2 — Background worker pipeline**  
A BullMQ worker picks up the job asynchronously after upload. It validates the file, encodes it into the right format per DSP (MP3 for Spotify, AAC for Apple Music, FLAC for Deezer), and dispatches via the adapter layer. The API stays responsive regardless of encoding time.

**Layer 3 — DSP adapter pattern**  
Each platform has its own isolated adapter. Spotify's metadata schema, Apple's codec requirements, Deezer's endpoint — all contained in one file each. Adding a new DSP is a new file, zero changes to existing code. When Spotify changed their API, we touched one file.

---

## Stack

| Layer | Tech |
|---|---|
| API | Node.js · TypeScript · Express |
| Upload | AWS S3 multipart · presigned URLs |
| Queue | BullMQ · Redis |
| Worker | Node.js · tsx · ffmpeg (stubbed) |
| Status | Server-Sent Events |
| Frontend | Next.js 14 · App Router |
| Types | Shared TypeScript package (pnpm workspaces) |

---

## Project structure

```
dsp-pipeline/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── services/UploadService.ts   # S3 multipart init + complete
│   │       ├── adapters/
│   │       │   ├── BaseDSPAdapter.ts       # abstract class + withRetry()
│   │       │   ├── SpotifyAdapter.ts
│   │       │   ├── AppleMusicAdapter.ts
│   │       │   ├── DeezerAdapter.ts
│   │       │   └── DSPRegistry.ts          # distributeAll() via Promise.allSettled
│   │       ├── routes/
│   │       │   ├── upload.ts               # POST /upload/init|complete
│   │       │   ├── webhooks.ts             # POST /webhooks/:dsp
│   │       │   └── status.ts               # GET /releases/:trackId/status (SSE)
│   │       └── db.ts                       # in-memory track status store
│   ├── worker/
│   │   └── src/index.ts                    # BullMQ processor · encode · retry
│   └── frontend/
│       └── src/
│           ├── app/demo/page.tsx
│           └── components/MiniDist.tsx     # live pipeline visualiser
└── packages/
    └── shared/
        └── src/index.ts                    # Track · EncodeJob · DSPStatus · DSPResult
```

---

## Running locally

**Prerequisites:** Node 20+, pnpm, Redis

```bash
git clone https://github.com/flobby41/dsp-pipeline
cd dsp-pipeline
cp .env.example .env   # fill in AWS_* and REDIS_URL
pnpm install
```

Start all three processes in parallel:

```bash
# Terminal 1 — API
pnpm --filter @dsp-pipeline/api dev

# Terminal 2 — Worker
pnpm --filter @dsp-pipeline/worker dev

# Terminal 3 — Frontend
pnpm --filter @dsp-pipeline/frontend dev
```

Then open [http://localhost:3000/demo](http://localhost:3000/demo).

---

## Key engineering decisions

**Why S3 multipart instead of a standard HTTP upload?**  
A single HTTP request for a 200 MB file will time out on most network conditions and gives you no recovery path. Multipart splits the file into chunks that upload in parallel, assembles them server-side, and lets you resume from the last completed chunk if the connection drops. The server never holds the bytes in memory.

**Why a separate worker process instead of handling encoding in the API?**  
Encoding is CPU-bound and slow. If it ran inside the API request cycle, every upload would block the event loop for the duration of encoding. The worker runs as a separate process, polls Redis for jobs, and reports progress back — the API responds in milliseconds regardless of what the worker is doing.

**Why the adapter pattern for DSPs?**  
Every streaming platform has different API conventions, metadata schemas, and authentication. Without isolation, changing one platform's integration leaks risk into the others. The adapter pattern gives each DSP a clear boundary — one class, one responsibility. `DSPRegistry.distributeAll()` runs them concurrently via `Promise.allSettled`, so a Spotify failure never blocks Apple Music delivery.

**Why the one sprint cost was worth it**  
Rebuilding instead of patching cost one sprint. What it prevented: months of reactive firefighting, silent failures in production, and artists losing trust in the platform. The tradeoff was clear once I mapped the blast radius of continuing to patch.

---

## What this doesn't include (yet)

- Real ffmpeg encoding (currently stubbed with `sleep` + `console.log`)
- PostgreSQL persistence (currently in-memory store)
- Authentication
- Actual DSP API credentials

These are intentionally omitted to keep the demo self-contained and runnable without external accounts.

---

## About

Built by [Florian Cheheb](https://silver-api.digital) · [LinkedIn](https://linkedin.com/in/silverapi) · [GitHub](https://github.com/flobby41)

