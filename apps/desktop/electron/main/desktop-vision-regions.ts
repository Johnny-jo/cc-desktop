type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };
type Image = { width: number; height: number; data: Uint8Array };
type Line = { text: string; confidence: number; box: Bounds };
type TextRegion = { text: string; confidence: number; bounds: Bounds; point: Point };
type ShapeRegion = { kind: "rectangle" | "icon"; bounds: Bounds; point: Point; label?: string };

const MAX_GRID_PIXELS = 2_100_000; // 1080p at native resolution, about 10 MiB for edges + flood queue.
const MAX_TEXTS = 160;
const MAX_SHAPES = 128;

function center(bounds: Bounds): Point {
  return { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) };
}

function readingOrder(a: { bounds: Bounds }, b: { bounds: Bounds }) {
  return a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x;
}

function contains(outer: Bounds, inner: Bounds, slack: number) {
  return outer.x - slack <= inner.x && outer.y - slack <= inner.y &&
    outer.x + outer.width + slack >= inner.x + inner.width &&
    outer.y + outer.height + slack >= inner.y + inner.height;
}

function readTexts(image: Image, lines: readonly Line[], origin: Point) {
  const texts: TextRegion[] = [];
  let truncated = false;
  for (const line of lines) {
    const { x, y, width, height } = line.box;
    const text = line.text.trim();
    if (!text || !Number.isFinite(x + y + width + height) || width <= 0 || height <= 0) continue;
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(image.width, Math.ceil(x + width));
    const bottom = Math.min(image.height, Math.ceil(y + height));
    if (right <= left || bottom <= top) continue;
    const bounds = { x: origin.x + left, y: origin.y + top, width: right - left, height: bottom - top };
    const duplicate = texts.find(item => item.text === text && contains(item.bounds, bounds, 1) && contains(bounds, item.bounds, 1));
    if (duplicate) {
      duplicate.confidence = Math.max(duplicate.confidence, line.confidence);
      continue;
    }
    if (texts.length === MAX_TEXTS) {
      truncated = true;
      break;
    }
    texts.push({ text, confidence: line.confidence, bounds, point: center(bounds) });
  }
  return { texts: texts.sort(readingOrder), truncated };
}

function contrast(rgba: Uint8Array, i: number, j: number) {
  return Math.abs(rgba[i] - rgba[j]) >= 18 || Math.abs(rgba[i + 1] - rgba[j + 1]) >= 18 ||
    Math.abs(rgba[i + 2] - rgba[j + 2]) >= 18;
}

function edgeGrid({ width, height, data }: Image) {
  const scale = Math.max(1, Math.ceil(Math.sqrt(width * height / MAX_GRID_PIXELS)), Math.ceil(Math.max(width, height) / 4096));
  const cols = Math.ceil(width / scale);
  const rows = Math.ceil(height / scale);
  // Keep a zero border so the component walk cannot wrap around a screen edge.
  const stride = cols + 2;
  const edges = new Uint8Array(stride * (rows + 2));
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const gridRow = (1 + Math.floor(y / scale)) * stride + 1;
    for (let x = 0, i = y * rowBytes; x < width; x++, i += 4) {
      if ((x > 0 && contrast(data, i, i - 4)) || (y > 0 && contrast(data, i, i - rowBytes))) {
        // Pool native contrast edges. Sampling a resized image would erase thin borders.
        edges[gridRow + Math.floor(x / scale)] = 1;
      }
    }
  }
  return { scale, cols, rows, stride, edges };
}

function shapeRegions(image: Image, texts: TextRegion[], origin: Point) {
  const { scale, cols, rows, stride, edges } = edgeGrid(image);
  const neighbors = [-stride - 1, -stride, -stride + 1, -1, 1, stride - 1, stride, stride + 1];
  const queue = new Int32Array(edges.length);
  const shapes: ShapeRegion[] = [];
  for (let seed = stride + 1; seed < edges.length - stride; seed++) {
    if (!edges[seed]) continue;
    let minX = cols, minY = rows, maxX = 0, maxY = 0;
    let count = 1;
    queue[0] = seed;
    edges[seed] = 0;
    for (let i = 0; i < count; i++) {
      const index = queue[i];
      const x = index % stride - 1;
      const y = Math.floor(index / stride) - 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const delta of neighbors) {
        const next = index + delta;
        if (edges[next]) {
          edges[next] = 0;
          queue[count++] = next;
        }
      }
    }

    // Edge coordinates denote boundaries between native pixels. At a crop edge
    // the last visible pixel is included in the returned half-open bounds.
    const left = minX * scale, top = minY * scale;
    const right = maxX === cols - 1 ? image.width : maxX * scale;
    const bottom = maxY === rows - 1 ? image.height : maxY * scale;
    const width = right - left, height = bottom - top;
    if (width < 6 || height < 6 || count < 6) continue;
    const bounds = { x: left + origin.x, y: top + origin.y, width, height };
    if (texts.some(line => contains(line.bounds, bounds, 1))) continue;
    const colsUsed = maxX - minX + 1, rowsUsed = maxY - minY + 1;
    if (count > colsUsed * rowsUsed * 0.72) continue;

    let topEdge = 0, bottomEdge = 0, leftEdge = 0, rightEdge = 0;
    for (let i = 0; i < count; i++) {
      const x = queue[i] % stride - 1;
      const y = Math.floor(queue[i] / stride) - 1;
      if (y === minY) topEdge++;
      if (y === maxY) bottomEdge++;
      if (x === minX) leftEdge++;
      if (x === maxX) rightEdge++;
    }
    const hasLeft = leftEdge >= rowsUsed * 0.55, hasRight = rightEdge >= rowsUsed * 0.55;
    const hasTop = topEdge >= colsUsed * 0.55, hasBottom = bottomEdge >= colsUsed * 0.55;
    const rectangle = (hasLeft || hasRight) && (hasTop || hasBottom) &&
      (hasLeft || minX === 0) && (hasRight || maxX === cols - 1) &&
      (hasTop || minY === 0) && (hasBottom || maxY === rows - 1);
    if (!rectangle && (width > 144 || height > 144 || width > height * 4 || height > width * 4)) continue;
    const kind = rectangle ? "rectangle" : "icon";
    // The inner and outer gradients of a thick stroke can be separate components.
    const slack = Math.max(3, scale);
    if (shapes.some(shape => shape.kind === kind && contains(shape.bounds, bounds, slack) && contains(bounds, shape.bounds, slack))) continue;
    if (shapes.length === MAX_SHAPES) return { shapes, truncated: true };
    shapes.push({ kind, bounds, point: center(bounds) });
  }
  return { shapes, truncated: false };
}

/** Geometric candidates only. A label is observed OCR inside the closest outline. */
export function analyzeDesktopRegions(image: Image, lines: readonly Line[], origin: Point): {
  texts: TextRegion[]; shapes: ShapeRegion[]; truncated: boolean;
} {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 ||
    image.width * image.height * 4 !== image.data.length) throw new RangeError("Expected a complete RGBA image");
  const textResult = readTexts(image, lines, origin);
  const { texts } = textResult;
  const { shapes, truncated } = shapeRegions(image, texts, origin);
  const labels = shapes.filter(shape => shape.kind === "rectangle")
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  for (const line of texts) {
    const enclosing = labels.find(shape => shape.bounds.height <= Math.max(48, line.bounds.height * 4) &&
      contains(shape.bounds, line.bounds, 1));
    if (enclosing) enclosing.label = enclosing.label ? enclosing.label + " " + line.text : line.text;
  }
  return { texts, shapes: shapes.sort(readingOrder), truncated: truncated || textResult.truncated };
}
