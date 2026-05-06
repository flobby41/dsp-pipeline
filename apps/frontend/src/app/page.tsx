import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>DSP Pipeline Demo</h1>
      <p style={{ marginTop: 12 }}>
        Open the <Link href="/demo">MiniDist demo</Link>.
      </p>
    </main>
  );
}

