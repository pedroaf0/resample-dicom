import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Isoslice — Resample DICOM isotrópico" },
      { name: "description", content: "Reamostre séries DICOM para voxels isotrópicos direto no navegador, sem enviar dados." },
      { property: "og:title", content: "Isoslice — Resample DICOM isotrópico" },
      { property: "og:description", content: "Reamostragem trilinear de séries DICOM no navegador." },
    ],
  }),
  component: Index,
});

type Info = { inp: string; out: string; gb: number };

function Index() {
  const [files, setFiles] = useState<File[]>([]);
  const [spacing, setSpacing] = useState(0.3);
  const [info, setInfo] = useState<Info | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Selecione a pasta da série DICOM.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);

  function download() {
    if (!result) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(result.blob);
    a.download = result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }

  async function run() {
    setError(""); setBusy(true); setProgress(0); setResult(null);
    try {
      const R = await import("@/lib/dicom-resample");
      setStatus("Lendo cabeçalhos...");
      const hdr = await R.loadHeaders(files, (i, n) => setStatus(`Lendo cabeçalhos ${i}/${n}`));
      const g = R.prepareGeometry(hdr);
      const shape = R.outputShape(g, spacing);
      setInfo({
        inp: `${g.cols} × ${g.rows} × ${g.count} (${g.colSpacing.toFixed(3)} × ${g.rowSpacing.toFixed(3)} × ${g.zSpacing.toFixed(3)} mm)`,
        out: `${shape.cols} × ${shape.rows} × ${shape.slices}`,
        gb: (shape.rows * shape.cols * shape.slices * 2) / 1024 ** 3,
      });

      // Output: stream everything into a ZIP in memory, then offer a download button.
      const { Zip, ZipPassThrough } = await import("fflate");
      const chunks: BlobPart[] = [];
      const zip = new Zip((err, d) => { if (err) throw err; chunks.push(d as BlobPart); });

      const template = await R.loadTemplate(g);
      const seriesUid = R.newUid();
      const frameUid = template["FrameOfReferenceUID"] ?? R.newUid();
      const cache = new Map<number, Float32Array>();
      const t0 = performance.now();
      for (let z = 0; z < shape.slices; z++) {
        const px = await R.resampleSlice(z, g, cache, shape, spacing);
        const buf = R.saveSlice(template, px, g, z, shape, spacing, seriesUid, frameUid);
        const name = `IM_${String(z + 1).padStart(6, "0")}.dcm`;
        const f = new ZipPassThrough(name); zip.add(f); f.push(new Uint8Array(buf), true);
        const el = (performance.now() - t0) / 1000;
        const rem = ((shape.slices - z - 1) * el) / (z + 1);
        setProgress(((z + 1) / shape.slices) * 100);
        setStatus(`${z + 1}/${shape.slices} fatias · restante ${(rem / 60).toFixed(1)} min`);
        if (z % 4 === 0) await new Promise((r) => setTimeout(r));
      }
      zip.end();
      setResult({ blob: new Blob(chunks, { type: "application/zip" }), name: `resample_${spacing}mm.zip` });
      setStatus(`Concluído: ${shape.slices} arquivos gerados. Clique em Baixar ZIP.`);
    } catch (e: any) {
      setError(e?.message ?? String(e)); setStatus("Falhou.");
    } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">Isoslice</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Resample DICOM isotrópico</h1>
        <p className="mt-3 text-muted-foreground">
          Interpolação trilinear para voxels cúbicos. Tudo roda no seu navegador — nenhum dado é enviado.
        </p>

        <section className="mt-10 space-y-6 rounded-lg border border-border bg-card p-6">
          <label className="block">
            <span className="text-sm font-medium">Pasta da série de entrada</span>
            <input type="file" multiple disabled={busy}
              // @ts-expect-error non-standard attribute
              webkitdirectory=""
              onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setInfo(null); setError(""); setStatus(`${e.target.files?.length ?? 0} arquivos selecionados.`); }}
              className="mt-2 block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-primary-foreground" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Espaçamento alvo (mm)</span>
            <input type="number" step="0.01" min="0.05" value={spacing} disabled={busy}
              onChange={(e) => setSpacing(Number(e.target.value))}
              className="mt-2 w-32 rounded-md border border-input bg-background px-3 py-2 font-mono" />
          </label>
          <button onClick={run} disabled={busy || !files.length || !(spacing > 0)}
            className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Processando..." : "Iniciar resample"}
          </button>
        </section>

        {info && (
          <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 font-mono text-sm">
            <dt className="text-muted-foreground">Entrada</dt><dd>{info.inp}</dd>
            <dt className="text-muted-foreground">Saída</dt><dd>{info.out} @ {spacing} mm</dd>
            <dt className="text-muted-foreground">Tamanho</dt><dd>{info.gb.toFixed(2)} GB</dd>
          </dl>
        )}
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-2 font-mono text-sm text-muted-foreground">{status}</p>
        {result && (
          <button onClick={download}
            className="mt-4 rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground">
            Baixar ZIP ({(result.blob.size / 1024 ** 2).toFixed(1)} MB)
          </button>
        )}
        {error && <p className="mt-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
        <p className="mt-10 text-xs text-muted-foreground">
          Suporta DICOM sem compressão. O resultado é baixado como um arquivo ZIP.
        </p>
      </div>
    </main>
  );
}
