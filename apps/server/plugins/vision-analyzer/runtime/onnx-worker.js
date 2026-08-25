import { parentPort } from "node:worker_threads";

const COCO80 = [
  "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light",
  "fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow",
  "elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee",
  "skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard",
  "tennis racket","bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple",
  "sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair","couch",
  "potted plant","bed","dining table","toilet","tv","laptop","mouse","remote","keyboard","cell phone",
  "microwave","oven","toaster","sink","refrigerator","book","clock","vase","scissors","teddy bear",
  "hair drier","toothbrush"
];

let runtimePromise;
let sharpPromise;
let cachedModelPath = "";
let cachedSession = null;
const trackerStates = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function modules() {
  runtimePromise ??= import("onnxruntime-node");
  sharpPromise ??= import("sharp");
  const [ortMod, sharpMod] = await Promise.all([runtimePromise, sharpPromise]);
  return {
    ort: ortMod.default ?? ortMod,
    sharp: sharpMod.default ?? sharpMod,
  };
}

async function sessionFor(ort, modelPath) {
  if (cachedSession && cachedModelPath === modelPath) return cachedSession;
  cachedSession = await ort.InferenceSession.create(modelPath);
  cachedModelPath = modelPath;
  trackerStates.clear();
  return cachedSession;
}

function trackerFor(key) {
  const safeKey = String(key || "default").slice(0, 256);
  let state = trackerStates.get(safeKey);
  if (!state) {
    state = { activeTracks: [], nextTrackId: 1, frame: 0 };
    trackerStates.set(safeKey, state);
  }
  return state;
}

async function preprocess(sharp, imageBuffer, size) {
  const probe = sharp(imageBuffer, { failOn: "none" });
  const meta = await probe.metadata();
  const sourceWidth = Number(meta.width ?? 0);
  const sourceHeight = Number(meta.height ?? 0);
  if (!sourceWidth || !sourceHeight) throw new Error("Could not read frame dimensions");

  const scale = Math.min(size / sourceWidth, size / sourceHeight);
  const resizedWidth = Math.max(1, Math.round(sourceWidth * scale));
  const resizedHeight = Math.max(1, Math.round(sourceHeight * scale));
  const padLeft = Math.floor((size - resizedWidth) / 2);
  const padTop = Math.floor((size - resizedHeight) / 2);
  const padRight = size - resizedWidth - padLeft;
  const padBottom = size - resizedHeight - padTop;

  const rgb = await sharp(imageBuffer, { failOn: "none" })
    .toColourspace("srgb")
    .removeAlpha()
    .resize(resizedWidth, resizedHeight, { fit: "fill" })
    .extend({
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight,
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer();

  const plane = size * size;
  const tensor = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i += 1) {
    const p = i * 3;
    tensor[i] = rgb[p] / 255;
    tensor[plane + i] = rgb[p + 1] / 255;
    tensor[plane * 2 + i] = rgb[p + 2] / 255;
  }

  return { tensor, sourceWidth, sourceHeight, scale, padLeft, padTop, size };
}

function toNormalizedBox(box, prep) {
  let [x1, y1, x2, y2] = box.map(Number);
  if (Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 2) {
    x1 *= prep.size;
    y1 *= prep.size;
    x2 *= prep.size;
    y2 *= prep.size;
  }
  const ox1 = clamp((x1 - prep.padLeft) / prep.scale, 0, prep.sourceWidth);
  const oy1 = clamp((y1 - prep.padTop) / prep.scale, 0, prep.sourceHeight);
  const ox2 = clamp((x2 - prep.padLeft) / prep.scale, 0, prep.sourceWidth);
  const oy2 = clamp((y2 - prep.padTop) / prep.scale, 0, prep.sourceHeight);
  const width = Math.max(0, ox2 - ox1);
  const height = Math.max(0, oy2 - oy1);
  return [
    ox1 / prep.sourceWidth,
    oy1 / prep.sourceHeight,
    width / prep.sourceWidth,
    height / prep.sourceHeight,
  ];
}

function iou(a, b) {
  const ax2 = a.x1 + a.w;
  const ay2 = a.y1 + a.h;
  const bx2 = b.x1 + b.w;
  const by2 = b.y1 + b.h;
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(ax2, bx2);
  const y2 = Math.min(ay2, by2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function bboxIou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  return iou(
    { x1: Number(a[0]), y1: Number(a[1]), w: Number(a[2]), h: Number(a[3]) },
    { x1: Number(b[0]), y1: Number(b[1]), w: Number(b[2]), h: Number(b[3]) },
  );
}

function nms(items, iouThreshold, maxDetections) {
  const sorted = items.slice().sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  while (sorted.length && kept.length < maxDetections) {
    const best = sorted.shift();
    kept.push(best);
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i].classId === best.classId && iou(sorted[i], best) >= iouThreshold) {
        sorted.splice(i, 1);
      }
    }
  }
  return kept;
}

function parseEndToEnd(output, prep, threshold, maxDetections) {
  const data = output.data;
  const dims = output.dims ?? [];
  const detections = [];

  if (dims[dims.length - 1] === 6) {
    const rows = Math.floor(data.length / 6);
    for (let row = 0; row < rows; row += 1) {
      const off = row * 6;
      const confidence = Number(data[off + 4]);
      if (!Number.isFinite(confidence) || confidence < threshold) continue;
      const classId = Math.round(Number(data[off + 5]));
      const bbox = toNormalizedBox([data[off], data[off + 1], data[off + 2], data[off + 3]], prep);
      detections.push({ classId, confidence, bbox });
    }
    return detections.sort((a, b) => b.confidence - a.confidence).slice(0, maxDetections);
  }

  if (dims.length >= 2 && dims[dims.length - 2] === 6) {
    const rows = Number(dims[dims.length - 1]);
    for (let row = 0; row < rows; row += 1) {
      const x1 = data[row];
      const y1 = data[rows + row];
      const x2 = data[rows * 2 + row];
      const y2 = data[rows * 3 + row];
      const confidence = Number(data[rows * 4 + row]);
      if (!Number.isFinite(confidence) || confidence < threshold) continue;
      const classId = Math.round(Number(data[rows * 5 + row]));
      detections.push({ classId, confidence, bbox: toNormalizedBox([x1, y1, x2, y2], prep) });
    }
    return detections.sort((a, b) => b.confidence - a.confidence).slice(0, maxDetections);
  }

  return null;
}

function parseRawYolo(output, prep, threshold, iouThreshold, maxDetections) {
  const dims = output.dims ?? [];
  const data = output.data;
  if (dims.length !== 3) throw new Error(`Unsupported YOLO output shape: ${JSON.stringify(dims)}`);

  const d1 = Number(dims[1]);
  const d2 = Number(dims[2]);
  const channelsFirst = d1 >= 5 && d1 <= 256 && d2 > d1;
  const channels = channelsFirst ? d1 : d2;
  const candidates = channelsFirst ? d2 : d1;
  if (channels < 5) throw new Error(`Unsupported YOLO channel count: ${channels}`);

  const classCount = channels - 4;
  const items = [];
  const at = channelsFirst
    ? (candidate, channel) => Number(data[channel * candidates + candidate])
    : (candidate, channel) => Number(data[candidate * channels + channel]);

  for (let candidate = 0; candidate < candidates; candidate += 1) {
    let classId = -1;
    let confidence = -Infinity;
    for (let c = 0; c < classCount; c += 1) {
      const score = at(candidate, c + 4);
      if (score > confidence) {
        confidence = score;
        classId = c;
      }
    }
    if (!Number.isFinite(confidence) || confidence < threshold) continue;

    const cx = at(candidate, 0);
    const cy = at(candidate, 1);
    const width = at(candidate, 2);
    const height = at(candidate, 3);
    let x1 = cx - width / 2;
    let y1 = cy - height / 2;
    let x2 = cx + width / 2;
    let y2 = cy + height / 2;
    if (Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 2) {
      x1 *= prep.size; y1 *= prep.size; x2 *= prep.size; y2 *= prep.size;
    }
    const bbox = toNormalizedBox([x1, y1, x2, y2], prep);
    items.push({
      classId,
      confidence,
      bbox,
      x1: bbox[0],
      y1: bbox[1],
      w: bbox[2],
      h: bbox[3],
    });
  }

  return nms(items, iouThreshold, maxDetections).map(({ x1, y1, w, h, ...item }) => item);
}

function shapeDetections(items) {
  const people = [];
  const objects = [];
  for (const item of items) {
    const type = COCO80[item.classId] ?? `class_${item.classId}`;
    const entry = {
      type,
      classId: item.classId,
      confidence: item.confidence,
      bbox: item.bbox,
    };
    if (type === "person") {
      people.push({ classId: item.classId, confidence: item.confidence, bbox: item.bbox });
    } else {
      objects.push(entry);
    }
  }
  return { people, objects };
}

function assignTrackIds(shaped, trackingKey) {
  const tracker = trackerFor(trackingKey);
  tracker.frame += 1;
  const detections = [
    ...shaped.people.map((entry) => ({ entry, classId: entry.classId, kind: "person" })),
    ...shaped.objects.map((entry) => ({ entry, classId: entry.classId, kind: entry.type })),
  ];
  const used = new Set();

  for (const detection of detections) {
    let best = null;
    let bestIou = 0.35;
    for (const track of tracker.activeTracks) {
      if (used.has(track.id) || track.classId !== detection.classId) continue;
      const overlap = bboxIou(track.bbox, detection.entry.bbox);
      if (overlap > bestIou) {
        best = track;
        bestIou = overlap;
      }
    }

    if (!best) {
      best = {
        id: tracker.nextTrackId++,
        classId: detection.classId,
        kind: detection.kind,
        bbox: detection.entry.bbox,
        lastSeen: tracker.frame,
      };
      tracker.activeTracks.push(best);
    } else {
      best.bbox = detection.entry.bbox;
      best.lastSeen = tracker.frame;
      best.kind = detection.kind;
    }

    used.add(best.id);
    detection.entry.trackId = best.id;
  }

  tracker.activeTracks = tracker.activeTracks.filter((track) => tracker.frame - track.lastSeen <= 8);
  return { shaped, activeTracks: tracker.activeTracks.length };
}

async function detect(message) {
  const { ort, sharp } = await modules();
  const session = await sessionFor(ort, message.modelPath);
  const inputSize = Math.max(160, Math.min(1280, Number(message.inputSize ?? 640)));
  const prep = await preprocess(sharp, Buffer.from(message.frameBase64, "base64"), inputSize);
  const inputName = session.inputNames?.[0];
  if (!inputName) throw new Error("ONNX model has no input tensor");
  const inputTensor = new ort.Tensor("float32", prep.tensor, [1, 3, inputSize, inputSize]);

  const started = performance.now();
  const outputs = await session.run({ [inputName]: inputTensor });
  const inferenceMs = performance.now() - started;
  const outputName = session.outputNames?.[0] ?? Object.keys(outputs)[0];
  const output = outputs[outputName];
  if (!output) throw new Error("ONNX model returned no output");

  const threshold = clamp(Number(message.threshold ?? 0.35), 0.01, 0.99);
  const iouThreshold = clamp(Number(message.iouThreshold ?? 0.45), 0.01, 0.99);
  const maxDetections = Math.max(1, Math.min(300, Number(message.maxDetections ?? 50)));

  let items = parseEndToEnd(output, prep, threshold, maxDetections);
  if (!items) items = parseRawYolo(output, prep, threshold, iouThreshold, maxDetections);
  const tracked = assignTrackIds(shapeDetections(items), message.trackingKey);

  return {
    ...tracked.shaped,
    inferenceMs: Math.round(inferenceMs * 10) / 10,
    inputSize,
    outputShape: output.dims ?? [],
    sourceWidth: prep.sourceWidth,
    sourceHeight: prep.sourceHeight,
    tracking: {
      type: "iou",
      key: String(message.trackingKey || "default").slice(0, 256),
      activeTracks: tracked.activeTracks,
    },
  };
}

if (!parentPort) throw new Error("onnx-worker must run inside a Worker thread");

parentPort.on("message", async (message) => {
  if (!message?.id || message.type !== "detect") return;
  try {
    const result = await detect(message);
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});