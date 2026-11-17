// @ts-nocheck -- numeric hot loops with strict index checks; logic mirrors the reference Python script.
// Browser port of the Python isotropic DICOM resampler (trilinear: bilinear in-plane + linear in Z).
import dcmjs from "dcmjs";

const { DicomMessage, DicomMetaDictionary, DicomDict } = dcmjs.data;
const ROW_BLOCK = 32;
const UNCOMPRESSED = ["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"];

type DS = Record<string, any>;
type Vec = [number, number, number];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]): Vec => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
const cross = (a: number[], b: number[]): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a: number[], b: number[], atol: number) => a.every((v, i) => Math.abs(v - b[i]) <= atol);
const nums = (v: any): number[] => (Array.isArray(v) ? v : [v]).map(Number);

function parse(buf: ArrayBuffer): DS {
  const dict = DicomMessage.readFile(buf, { ignoreErrors: true });
  const ds = DicomMetaDictionary.naturalizeDataset(dict.dict);
  ds._meta = DicomMetaDictionary.naturalizeDataset(dict.meta);
  return ds;
}

export interface Geometry {
  ordered: { proj: number; file: File; ds: DS; pos: number[] }[];
  iop: number[]; normal: Vec; origin: number[];
  rows: number; cols: number; rowSpacing: number; colSpacing: number; zSpacing: number; count: number;
}

export async function loadHeaders(files: File[], onProgress?: (i: number, n: number) => void) {
  const out: { file: File; ds: DS }[] = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i + 1, files.length);
    try {
      const ds = parse(await files[i].arrayBuffer());
      delete ds.PixelData; // keep memory low; re-read later
      if (["ImagePositionPatient", "ImageOrientationPatient", "PixelSpacing", "Rows", "Columns"].every((k) => ds[k] != null))
        out.push({ file: files[i], ds });
    } catch { /* not DICOM */ }
  }
  if (out.length < 2) throw new Error("Série DICOM inválida ou incompleta.");
  return out;
}

export function prepareGeometry(files: { file: File; ds: DS }[]): Geometry {
  const first = files[0].ds;
  const iop = nums(first.ImageOrientationPatient);
  const rowDir = norm(iop.slice(0, 3)), colDir = norm(iop.slice(3));
  const normal = norm(cross(rowDir, colDir));
  const spacing = nums(first.PixelSpacing);
  const ordered = files.map(({ file, ds }) => {
    if (+ds.Rows !== +first.Rows || +ds.Columns !== +first.Columns) throw new Error("Dimensões inconsistentes.");
    if (!close(nums(ds.ImageOrientationPatient), iop, 1e-4)) throw new Error("Orientação inconsistente.");
    if (!close(nums(ds.PixelSpacing), spacing, 1e-5)) throw new Error("PixelSpacing inconsistente.");
    const pos = nums(ds.ImagePositionPatient);
    return { proj: dot(pos, normal), file, ds, pos };
  }).sort((a, b) => a.proj - b.proj);
  const diffs = ordered.slice(1).map((o, i) => o.proj - ordered[i].proj);
  if (diffs.some((d) => d <= 0)) throw new Error("Posições duplicadas ou inválidas.");
  const sorted = [...diffs].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  const z = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  if (diffs.some((d) => Math.abs(d - z) > 0.02 + 0.01 * Math.abs(z))) throw new Error("Espaçamento entre fatias irregular.");
  const origin = ordered[0].pos;
  for (const o of ordered) {
    const exp = origin.map((v, i) => v + normal[i] * (o.proj - ordered[0].proj));
    if (!close(o.pos, exp, 0.15)) throw new Error("Geometria inclinada não suportada.");
  }
  return { ordered, iop, normal, origin, rows: +first.Rows, cols: +first.Columns,
    rowSpacing: spacing[0], colSpacing: spacing[1], zSpacing: z, count: ordered.length };
}

export function outputShape(g: Geometry, t: number) {
  return {
    rows: Math.ceil(((g.rows - 1) * g.rowSpacing) / t) + 1,
    cols: Math.ceil(((g.cols - 1) * g.colSpacing) / t) + 1,
    slices: Math.ceil(((g.count - 1) * g.zSpacing) / t) + 1,
  };
}

async function readSlice(g: Geometry, idx: number): Promise<Float32Array> {
  const ds = parse(await g.ordered[idx].file.arrayBuffer());
  const ts = ds._meta?.TransferSyntaxUID;
  if (ts && !UNCOMPRESSED.includes(ts)) throw new Error(`Transfer syntax comprimida não suportada (${ts}).`);
  const raw: ArrayBuffer = Array.isArray(ds.PixelData) ? ds.PixelData[0] : ds.PixelData;
  const n = g.rows * g.cols;
  const bits = +ds.BitsAllocated, signed = +ds.PixelRepresentation === 1;
  const src = bits === 16 ? (signed ? new Int16Array(raw, 0, n) : new Uint16Array(raw, 0, n))
    : bits === 8 ? (signed ? new Int8Array(raw, 0, n) : new Uint8Array(raw, 0, n))
    : bits === 32 ? (signed ? new Int32Array(raw, 0, n) : new Uint32Array(raw, 0, n)) : null;
  if (!src) throw new Error(`BitsAllocated ${bits} não suportado.`);
  const slope = Number(ds.RescaleSlope ?? 1), icpt = Number(ds.RescaleIntercept ?? 0);
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = src[i] * slope + icpt;
  return arr;
}

function sample(src: Float32Array, R: number, C: number, r: number, c: number) {
  r = Math.min(Math.max(r, 0), R - 1); c = Math.min(Math.max(c, 0), C - 1);
  const r0 = Math.floor(r), c0 = Math.floor(c);
  const r1 = Math.min(r0 + 1, R - 1), c1 = Math.min(c0 + 1, C - 1);
  const fr = r - r0, fc = c - c0;
  const a = src[r0 * C + c0] * (1 - fc) + src[r0 * C + c1] * fc;
  const b = src[r1 * C + c0] * (1 - fc) + src[r1 * C + c1] * fc;
  return a * (1 - fr) + b * fr;
}

export async function resampleSlice(z: number, g: Geometry, cache: Map<number, Float32Array>, shape: { rows: number; cols: number }, t: number) {
  const zs = (z * t) / g.zSpacing;
  const z0 = Math.min(Math.floor(zs), g.count - 1), z1 = Math.min(z0 + 1, g.count - 1);
  const alpha = zs - z0;
  if (!cache.has(z0)) cache.set(z0, await readSlice(g, z0));
  if (!cache.has(z1)) cache.set(z1, await readSlice(g, z1));
  const s0 = cache.get(z0)!, s1 = cache.get(z1)!;
  const out = new Int16Array(shape.rows * shape.cols);
  const cc = new Float32Array(shape.cols).map((_, i) => (i * t) / g.colSpacing);
  for (let start = 0; start < shape.rows; start += ROW_BLOCK) {
    const end = Math.min(start + ROW_BLOCK, shape.rows);
    for (let r = start; r < end; r++) {
      const rr = (r * t) / g.rowSpacing;
      for (let c = 0; c < shape.cols; c++) {
        let v = sample(s0, g.rows, g.cols, rr, cc[c]);
        if (z0 !== z1) v = v * (1 - alpha) + sample(s1, g.rows, g.cols, rr, cc[c]) * alpha;
        out[r * shape.cols + c] = Math.max(-32768, Math.min(32767, Math.round(v)));
      }
    }
  }
  for (const k of [...cache.keys()]) if (k !== z0 && k !== z1) cache.delete(k);
  return out;
}

export async function loadTemplate(g: Geometry) {
  return parse(await g.ordered[0].file.arrayBuffer());
}

export function saveSlice(template: DS, pixels: Int16Array, g: Geometry, z: number, shape: { rows: number; cols: number }, t: number, seriesUid: string, frameUid: string): ArrayBuffer {
  const { _meta, PixelData, SmallestImagePixelValue, LargestImagePixelValue, _vrMap, ...rest } = template;
  void _meta; void PixelData; void SmallestImagePixelValue; void LargestImagePixelValue; void _vrMap;
  const sop = DicomMetaDictionary.uid();
  const pos = g.origin.map((v, i) => v + g.normal[i] * z * t);
  const ds: DS = {
    ...rest,
    SOPInstanceUID: sop, SeriesInstanceUID: seriesUid, FrameOfReferenceUID: frameUid,
    Rows: shape.rows, Columns: shape.cols, PixelSpacing: [t, t],
    SliceThickness: t, SpacingBetweenSlices: t,
    ImageOrientationPatient: g.iop, ImagePositionPatient: pos, InstanceNumber: z + 1,
    RescaleSlope: 1, RescaleIntercept: 0,
    BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 1,
    SamplesPerPixel: 1, PhotometricInterpretation: "MONOCHROME2",
    PixelData: [pixels.buffer], _vrMap: { PixelData: "OW" },
  };
  const meta = {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: template.SOPClassUID, MediaStorageSOPInstanceUID: sop,
    TransferSyntaxUID: "1.2.840.10008.1.2.1", ImplementationClassUID: "1.2.826.0.1.3680043.10.1",
    ImplementationVersionName: "RESAMPLE_WEB",
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(ds);
  return dict.write();
}

export const newUid = () => DicomMetaDictionary.uid() as string;
