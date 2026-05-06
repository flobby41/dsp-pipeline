"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const DSPS = [
  { id: "spotify", name: "Spotify", fmt: "MP3 · 320kbps", col: "#1DB954" },
  { id: "apple", name: "Apple Music", fmt: "AAC · 256kbps", col: "#FF375F" },
  { id: "deezer", name: "Deezer", fmt: "FLAC · Lossless", col: "#A238FF" },
] as const;

const STAGES = ["upload", "worker", "distribute", "live"] as const;
const STAGE_LABELS = {
  upload: "S3 MULTIPART",
  worker: "WORKER",
  distribute: "DSP ADAPTERS",
  live: "LIVE",
} as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LOG_COL: Record<string, string> = {
  sys: "#7CA9CC",
  info: "rgba(255,255,255,0.45)",
  upload: "#60A5FA",
  ok: "#00E5A0",
  err: "#F87171",
  warn: "#FBBF24",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;0,600;1,300&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'IBM Plex Mono',monospace;background:#080A0D;color:rgba(255,255,255,0.85);overflow:hidden}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes fadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes pulse{0%,100%{opacity:0.5}50%{opacity:1}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes glow{0%,100%{box-shadow:0 0 0 rgba(0,229,160,0)}50%{box-shadow:0 0 14px rgba(0,229,160,0.35)}}
.fadeup{animation:fadeUp 0.2s ease both}
.chunk-bar{height:100%;border-radius:2px;transition:width 0.09s ease-out}
.chunk-active{background:linear-gradient(90deg,#00C98A,#00E5A0);background-size:200% 100%;animation:shimmer 1.2s infinite}
.chunk-done{background:#00E5A0}
.dsp-live{animation:glow 2s ease-in-out infinite}
.cursor{display:inline-block;width:7px;height:12px;background:#00E5A0;animation:blink 1s step-end infinite;vertical-align:middle;margin-left:2px}
:::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:2px}
`;

type DspUiState = {
  status: string;
  pct: number;
  retries: number;
};

type DSPStatus = {
  dspId: "spotify" | "apple" | "deezer";
  trackId: string;
  status: "pending" | "sending" | "retrying" | "live" | "failed";
  retries: number;
  confirmedAt?: string;
};

type InitResponse = {
  uploadId: string;
  s3Key: string;
  parts: { partNumber: number; presignedUrl: string }[];
};

type CompleteResponse = {
  trackId: string;
};

const PART_SIZE_BYTES = 10 * 1024 * 1024;

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
}

function xhrPutPart(
  url: string,
  body: Blob,
  onProgress: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const pct = (evt.loaded / evt.total) * 100;
      onProgress(pct);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const eTag = xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag");
        if (!eTag) {
          reject(new Error("Missing ETag response header"));
          return;
        }
        resolve(eTag);
        return;
      }
      reject(new Error(`PUT failed with status ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Network error during PUT"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(body);
  });
}

function createZeroBlob(byteLength: number): Blob {
  return new Blob([new Uint8Array(byteLength)], { type: "application/octet-stream" });
}

function mapStatusToPct(status: DSPStatus["status"]): number {
  if (status === "pending") return 0;
  if (status === "sending") return 55;
  if (status === "retrying") return 30;
  if (status === "failed") return 100;
  return 100;
}

export default function MiniDist() {
  const [phase, setPhase] = useState("idle");
  const [fname, setFname] = useState("");
  const [chunks, setChunks] = useState<number[]>([]);
  const [uid, setUid] = useState("");
  const [encPct, setEncPct] = useState(0);
  const [encStep, setEncStep] = useState(-1);
  const [dsps, setDsps] = useState<Record<string, DspUiState>>(() =>
    Object.fromEntries(DSPS.map((d) => [d.id, { status: "idle", pct: 0, retries: 0 }])),
  );
  const [logs, setLogs] = useState<
    { ts: string; text: string; type: string; id: number }[]
  >([]);
  const [dragOver, setDragOver] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.prepend(el);
    return () => el.remove();
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const log = useCallback((text: string, type = "info") => {
    const ts = new Date().toISOString().slice(11, 23);
    setLogs((p) => [...p.slice(-120), { ts, text, type, id: Math.random() }]);
  }, []);

  const run = useCallback(
    async (name = "midnight_drive_master.wav") => {
      const apiBase = getApiBaseUrl();
      const sizeBytes = 196_608_000;

      setFname(name);
      setPhase("uploading");
      setChunks([]);
      setUid("");
      setEncPct(0);
      setEncStep(-1);
      setDsps(
        Object.fromEntries(DSPS.map((d) => [d.id, { status: "pending", pct: 0, retries: 0 }])),
      );
      setLogs([]);

      const initRes = await fetch(`${apiBase}/upload/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name, sizeBytes }),
      });

      if (!initRes.ok) {
        throw new Error(`upload/init failed (${initRes.status})`);
      }

      const initJson = (await initRes.json()) as InitResponse;
      setUid(initJson.uploadId);
      setChunks(new Array(initJson.parts.length).fill(0));

      log(`CreateMultipartUpload → UploadId: ${initJson.uploadId}`, "sys");
      log(
        `File split into ${initJson.parts.length} parts × ${(sizeBytes / 1024 / 1024 / initJson.parts.length).toFixed(1)} MB`,
        "info",
      );

      const etagsByPartNumber = new Map<number, string>();

      await Promise.all(
        initJson.parts.map(async (part, idx) => {
          const byteLength =
            part.partNumber < initJson.parts.length
              ? PART_SIZE_BYTES
              : sizeBytes - PART_SIZE_BYTES * (initJson.parts.length - 1);

          log(`PUT Part ${part.partNumber}/${initJson.parts.length} → in-flight`, "upload");

          const eTag = await xhrPutPart(
            part.presignedUrl,
            createZeroBlob(Math.max(1, byteLength)),
            (pct) => {
              setChunks((prev) => {
                const next = prev.length === initJson.parts.length ? [...prev] : new Array(initJson.parts.length).fill(0);
                next[idx] = pct;
                return next;
              });
            },
          );

          etagsByPartNumber.set(part.partNumber, eTag);
          log(`Part ${part.partNumber} complete · ETag: ${eTag}`, "ok");
        }),
      );

      log(`CompleteMultipartUpload → s3://${initJson.s3Key}`, "sys");

      const completeRes = await fetch(`${apiBase}/upload/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: initJson.uploadId,
          s3Key: initJson.s3Key,
          parts: initJson.parts
            .map((p) => ({
              partNumber: p.partNumber,
              eTag: etagsByPartNumber.get(p.partNumber) ?? "",
            }))
            .filter((p) => p.eTag),
        }),
      });

      if (!completeRes.ok) {
        throw new Error(`upload/complete failed (${completeRes.status})`);
      }

      const completeJson = (await completeRes.json()) as CompleteResponse;
      const trackId = completeJson.trackId;

      await sleep(400);
      setPhase("encoding");
      log("Job dequeued · Worker-01 assigned", "sys");
      log("ffmpeg: validating audio headers...", "info");

      // Preserve the same encoding animation visuals.
      await new Promise<void>((resolve) => {
        let p = 0;
        const milestones = [
          {
            at: 18,
            fn: () => {
              setEncStep(0);
              log("ffmpeg → MP3 320kbps  [Spotify adapter]", "info");
            },
          },
          {
            at: 50,
            fn: () => {
              setEncStep(1);
              log("ffmpeg → AAC 256kbps  [Apple Music adapter]", "info");
            },
          },
          {
            at: 76,
            fn: () => {
              setEncStep(2);
              log("ffmpeg → FLAC lossless  [Deezer adapter]", "info");
            },
          },
        ];
        const iv = window.setInterval(() => {
          p = Math.min(100, p + 1.8 + Math.random() * 2.4);
          setEncPct(p);
          milestones.forEach((m) => {
            if (p >= m.at && p < m.at + 2.5) m.fn();
          });
          if (p >= 100) {
            window.clearInterval(iv);
            log("All formats encoded · uploaded to S3 /processed/", "ok");
            resolve();
          }
        }, 88);
      });

      await sleep(350);
      setPhase("distributing");
      log("DSP Adapter layer: dispatching to 3 platforms", "sys");

      const es = new EventSource(`${apiBase}/releases/${trackId}/status`);

      const applyStatuses = (statuses: DSPStatus[]) => {
        setDsps((prev) => {
          const next = { ...prev };
          for (const s of statuses) {
            next[s.dspId] = {
              status: s.status,
              pct: mapStatusToPct(s.status),
              retries: s.retries ?? 0,
            };
          }
          return next;
        });

        const allLive = statuses.length > 0 && statuses.every((s) => s.status === "live");
        if (allLive) {
          es.close();
          setPhase("live");
          log("Pipeline complete · release live on all 3 platforms", "ok");
        }
      };

      es.addEventListener("status", (evt) => {
        try {
          const data = JSON.parse((evt as MessageEvent).data) as DSPStatus[];
          applyStatuses(data);
        } catch {
          // ignore
        }
      });

      es.onerror = () => {
        // eslint-disable-next-line no-console
        console.warn("SSE connection error");
      };
    },
    [log],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) run(f.name);
    },
    [run],
  );

  const nChunks = chunks.length || 1;
  const uploadAvg = chunks.reduce((a, b) => a + b, 0) / nChunks;
  const stageIdx = STAGES.indexOf(phase as (typeof STAGES)[number]);

  return (
    <div
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        background: "#080A0D",
        color: "rgba(255,255,255,0.85)",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span
            style={{
              color: "#00E5A0",
              fontWeight: 600,
              fontSize: 12,
              letterSpacing: "0.12em",
            }}
          >
            MINIDIST
          </span>
          <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 11 }}>
            music distribution pipeline
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {STAGES.map((s, i) => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  color:
                    i === stageIdx
                      ? "#00E5A0"
                      : i < stageIdx
                        ? "rgba(0,229,160,0.4)"
                        : "rgba(255,255,255,0.2)",
                  fontWeight: i === stageIdx ? 500 : 300,
                  transition: "color 0.4s",
                }}
              >
                {STAGE_LABELS[s]}
              </span>
              {i < STAGES.length - 1 && (
                <span style={{ color: "rgba(255,255,255,0.12)", fontSize: 10 }}>→</span>
              )}
            </div>
          ))}
        </div>
        {phase === "live" && (
          <button
            onClick={() => {
              setPhase("idle");
              setLogs([]);
            }}
            style={{
              background: "rgba(0,229,160,0.1)",
              border: "1px solid rgba(0,229,160,0.3)",
              color: "#00E5A0",
              borderRadius: 3,
              padding: "4px 12px",
              fontSize: 10,
              fontFamily: "inherit",
              cursor: "pointer",
              letterSpacing: "0.06em",
            }}
          >
            ↺ RUN AGAIN
          </button>
        )}
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Main area */}
        <div
          style={{
            flex: 1,
            padding: 24,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {phase === "idle" && (
            <DropZone
              dragOver={dragOver}
              onDrop={handleDrop}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDemo={() => run()}
            />
          )}

          {phase === "uploading" && (
            <ChunkView
              chunks={chunks}
              fname={fname}
              uid={uid}
              avg={uploadAvg}
              totalParts={chunks.length}
            />
          )}
          {phase === "encoding" && <EncodeView pct={encPct} step={encStep} fname={fname} />}
          {(phase === "distributing" || phase === "live") && <DistribView dsps={dsps} phase={phase} />}
        </div>

        {/* Terminal */}
        <div
          style={{
            width: 320,
            borderLeft: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.07)",
              fontSize: 10,
              letterSpacing: "0.1em",
              color: "rgba(255,255,255,0.25)",
              flexShrink: 0,
            }}
          >
            SYSTEM LOG
          </div>
          <div
            ref={logRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {logs.length === 0 ? (
              <span style={{ color: "rgba(255,255,255,0.15)", fontSize: 11 }}>
                awaiting pipeline start<span className="cursor" />
              </span>
            ) : (
              logs.map((l) => <LogLine key={l.id} {...l} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function DropZone({
  dragOver,
  onDrop,
  onDragOver,
  onDragLeave,
  onDemo,
}: {
  dragOver: boolean;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDemo: () => void;
}) {
  return (
    <div
      className="fadeup"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        paddingBottom: 40,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <p
          style={{
            fontSize: 10,
            letterSpacing: "0.18em",
            color: "rgba(255,255,255,0.25)",
            marginBottom: 14,
          }}
        >
          PRODUCTION SYSTEM · REBUILT AS PORTFOLIO DEMO
        </p>
        <h1 style={{ fontSize: 26, fontWeight: 500, lineHeight: 1.25, letterSpacing: "-0.01em" }}>
          S3 Multipart Upload
          <br />
          <span style={{ color: "#00E5A0" }}>→ DSP Adapter Layer</span>
        </h1>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 10, lineHeight: 1.6 }}>
          Originally built at Alter K Global Music Services
          <br />
          Handling thousands of artists · millions of tracks
        </p>
      </div>

      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        style={{
          border: `1px dashed ${dragOver ? "#00E5A0" : "rgba(255,255,255,0.15)"}`,
          borderRadius: 5,
          padding: "32px 56px",
          textAlign: "center",
          cursor: "pointer",
          background: dragOver ? "rgba(0,229,160,0.04)" : "transparent",
          transition: "all 0.2s",
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 10, opacity: 0.6 }}>♫</div>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Drop a .wav / .flac / .mp3 file here</p>
        <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginTop: 5 }}>
          up to 500 MB · multipart handled automatically
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ height: "1px", width: 50, background: "rgba(255,255,255,0.1)" }} />
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.2)" }}>or</span>
        <div style={{ height: "1px", width: 50, background: "rgba(255,255,255,0.1)" }} />
      </div>

      <button
        onClick={onDemo}
        style={{
          background: "#00E5A0",
          color: "#080A0D",
          border: "none",
          borderRadius: 4,
          padding: "10px 28px",
          fontSize: 12,
          fontFamily: "inherit",
          fontWeight: 600,
          letterSpacing: "0.08em",
          cursor: "pointer",
        }}
      >
        ▶ RUN DEMO PIPELINE
      </button>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
        {["S3 multipart", "BullMQ workers", "DSP adapters", "Retry + webhooks"].map((t) => (
          <span key={t} style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", letterSpacing: "0.05em" }}>
            · {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChunkView({
  chunks,
  fname,
  uid,
  avg,
  totalParts,
}: {
  chunks: number[];
  fname: string;
  uid: string;
  avg: number;
  totalParts: number;
}) {
  return (
    <div className="fadeup" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <p style={{ fontSize: 10, letterSpacing: "0.1em", color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>
          S3 MULTIPART UPLOAD
        </p>
        <p style={{ fontSize: 18, fontWeight: 500 }}>{fname}</p>
        <p style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 5 }}>
          UploadId: <span style={{ color: "#00E5A0" }}>{uid}</span>
        </p>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 6 }}>
          <span>Aggregate progress</span>
          <span>{Math.round(avg)}%</span>
        </div>
        <ProgressBar pct={avg} color="#00E5A0" shimmer height={3} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {chunks.map((pct, i) => (
          <div key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.28)", marginBottom: 4 }}>
              <span>
                Part {i + 1}/{totalParts}
              </span>
              <span style={{ color: pct >= 100 ? "#00E5A0" : "rgba(255,255,255,0.28)" }}>
                {pct >= 100 ? "✓  complete" : `${Math.round(pct)}%`}
              </span>
            </div>
            <ProgressBar pct={pct} color={pct >= 100 ? "#00E5A0" : "#00C98A"} shimmer={pct < 100} height={4} />
          </div>
        ))}
      </div>

      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.22)", lineHeight: 1.8, borderTop: "1px solid rgba(255,255,255,0.07)", paddingTop: 14 }}>
        <div>↳ Parts upload concurrently · assembled server-side on completion</div>
        <div>↳ Resumable on interruption · eliminates timeout on large files</div>
        <div>↳ Presigned URLs for secure, temporary DSP access</div>
      </div>
    </div>
  );
}

function EncodeView({ pct, step, fname }: { pct: number; step: number; fname: string }) {
  const formats = [
    { label: "MP3 · 320kbps", dsp: "Spotify adapter", threshold: 18 },
    { label: "AAC · 256kbps", dsp: "Apple Music adapter", threshold: 50 },
    { label: "FLAC · Lossless", dsp: "Deezer adapter", threshold: 76 },
  ];

  return (
    <div className="fadeup" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <p style={{ fontSize: 10, letterSpacing: "0.1em", color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>
          WORKER PIPELINE · ENCODING
        </p>
        <p style={{ fontSize: 18, fontWeight: 500 }}>{fname}</p>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 6 }}>
          <span>ffmpeg progress</span>
          <span>{Math.round(pct)}%</span>
        </div>
        <ProgressBar pct={pct} color="#3B82F6" shimmer height={4} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {formats.map((f) => {
          const done = pct >= f.threshold + 24;
          const active = pct >= f.threshold && !done;
          const dotCol = done ? "#00E5A0" : active ? "#3B82F6" : "rgba(255,255,255,0.2)";
          return (
            <div
              key={f.dsp}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                background: "#0D1017",
                border: `1px solid ${done ? "rgba(0,229,160,0.2)" : "rgba(255,255,255,0.06)"}`,
                borderRadius: 4,
                transition: "border-color 0.4s",
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: dotCol,
                  flexShrink: 0,
                  animation: active ? "pulse 0.8s infinite" : "none",
                }}
              />
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 12, fontWeight: 500 }}>{f.label}</p>
                <p style={{ fontSize: 10, color: "rgba(255,255,255,0.32)" }}>{f.dsp}</p>
              </div>
              <span style={{ fontSize: 10, color: done ? "#00E5A0" : active ? "#3B82F6" : "rgba(255,255,255,0.25)" }}>
                {done ? "✓  done" : active ? "encoding..." : "queued"}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.22)", lineHeight: 1.8, borderTop: "1px solid rgba(255,255,255,0.07)", paddingTop: 14 }}>
        <div>↳ BullMQ worker runs asynchronously · API stays responsive</div>
        <div>↳ Each encoded format stored in S3 /processed/ for DSP delivery</div>
      </div>
    </div>
  );
}

function DistribView({ dsps, phase }: { dsps: Record<string, DspUiState>; phase: string }) {
  return (
    <div className="fadeup" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <p style={{ fontSize: 10, letterSpacing: "0.1em", color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>
          DSP ADAPTER LAYER · DISTRIBUTION
        </p>
        {phase === "live" && <p style={{ fontSize: 18, fontWeight: 500, color: "#00E5A0" }}>♫ Release live on all platforms</p>}
        {phase === "distributing" && (
          <p style={{ fontSize: 18, fontWeight: 500 }}>
            Dispatching to 3 platforms<span style={{ color: "#00E5A0" }}>...</span>
          </p>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {DSPS.map((dsp) => {
          const state = dsps[dsp.id] || ({} as DspUiState);
          const { status, pct = 0, retries = 0 } = state;
          const borderCol =
            status === "live"
              ? "rgba(0,229,160,0.3)"
              : status === "failed"
                ? "rgba(248,113,113,0.3)"
                : status === "retrying"
                  ? "rgba(251,191,36,0.3)"
                  : "rgba(255,255,255,0.07)";

          return (
            <div
              key={dsp.id}
              className={status === "live" ? "dsp-live" : ""}
              style={{
                background: "#0D1017",
                border: `1px solid ${borderCol}`,
                borderRadius: 4,
                padding: "14px 16px",
                transition: "border-color 0.4s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: status !== "idle" && status !== "pending" ? 12 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 9, height: 9, borderRadius: "50%", background: dsp.col, flexShrink: 0 }} />
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 500 }}>{dsp.name}</p>
                    <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{dsp.fmt}</p>
                  </div>
                </div>
                <StatusPill status={status} retries={retries} />
              </div>

              {status !== "idle" && status !== "pending" && (
                <div>
                  <ProgressBar
                    pct={pct}
                    color={status === "live" ? "#00E5A0" : status === "failed" ? "#F87171" : status === "retrying" ? "#FBBF24" : dsp.col}
                    height={3}
                  />
                  {retries > 0 && <p style={{ fontSize: 10, color: "#FBBF24", marginTop: 6 }}>↻ Retry #{retries} · exponential backoff</p>}
                </div>
              )}
              {(status === "idle" || status === "pending") && (
                <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginTop: 8 }}>waiting for worker to complete...</p>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.22)", lineHeight: 1.8, borderTop: "1px solid rgba(255,255,255,0.07)", paddingTop: 14 }}>
        <div>↳ Each DSP has its own isolated adapter · API rules, metadata, format per platform</div>
        <div>↳ Adding a new DSP = new adapter file · zero changes to existing code</div>
        <div>↳ Webhook confirms track is live · artist notified by email per platform</div>
      </div>
    </div>
  );
}

function StatusPill({ status, retries }: { status: string; retries: number }) {
  const cfg =
    ({
      idle: { label: "IDLE", bg: "rgba(255,255,255,0.06)", col: "rgba(255,255,255,0.3)" },
      pending: { label: "PENDING", bg: "rgba(255,255,255,0.06)", col: "rgba(255,255,255,0.3)" },
      sending: { label: "SENDING", bg: "rgba(59,130,246,0.12)", col: "#60A5FA" },
      failed: { label: "FAILED", bg: "rgba(248,113,113,0.12)", col: "#F87171" },
      retrying: { label: `RETRY #${retries}`, bg: "rgba(251,191,36,0.12)", col: "#FBBF24" },
      live: { label: "LIVE", bg: "rgba(0,229,160,0.12)", col: "#00E5A0" },
    } as const)[status] ||
    ({ label: status.toUpperCase(), bg: "rgba(255,255,255,0.06)", col: "rgba(255,255,255,0.3)" } as const);

  return (
    <div
      style={{
        padding: "3px 9px",
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.07em",
        background: cfg.bg,
        color: cfg.col,
        animation: status === "sending" ? "pulse 1s infinite" : "none",
      }}
    >
      {cfg.label}
    </div>
  );
}

function ProgressBar({
  pct,
  color,
  height = 4,
  shimmer = false,
}: {
  pct: number;
  color: string;
  height?: number;
  shimmer?: boolean;
}) {
  return (
    <div style={{ height, background: "rgba(255,255,255,0.07)", borderRadius: 2, overflow: "hidden" }}>
      <div
        className={shimmer && pct < 100 ? "chunk-bar chunk-active" : "chunk-bar chunk-done"}
        style={{ width: `${Math.round(pct)}%`, background: color }}
      />
    </div>
  );
}

function LogLine({ ts, text, type }: { ts: string; text: string; type: string }) {
  return (
    <div className="log-entry" style={{ display: "flex", gap: 8, fontSize: 10, lineHeight: 1.55 }}>
      <span style={{ color: "rgba(255,255,255,0.18)", flexShrink: 0, userSelect: "none" }}>{ts}</span>
      <span style={{ color: LOG_COL[type] || LOG_COL.info, wordBreak: "break-all" }}>{text}</span>
    </div>
  );
}

