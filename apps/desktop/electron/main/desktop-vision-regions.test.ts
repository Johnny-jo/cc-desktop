import { expect, it } from "vitest";
import { analyzeDesktopRegions } from "./desktop-vision-regions";

const origin = { x: -800, y: 45 };
function canvas(width: number, height: number, background: number) {
  const data = new Uint8Array(width * height * 4);
  data.fill(background);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  function fill(x: number, y: number, w: number, h: number, color: number) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const offset = 4 * (row * width + col);
        data.fill(color, offset, offset + 3);
      }
    }
  }
  return { width, height, data, fill };
}

it.each([[245, 66], [26, 200]])("pairs outlined controls with OCR on background %i", (bg, ink) => {
  const image = canvas(200, 60, bg);
  image.fill(12, 10, 90, 36, ink);
  image.fill(14, 12, 86, 32, bg);
  image.fill(34, 22, 9, 10, ink);
  image.fill(50, 22, 9, 10, ink);
  const line = { text: "打开", confidence: 0.93, box: { x: 33, y: 21, width: 40, height: 12 } };
  expect(analyzeDesktopRegions(image, [line], origin)).toEqual({
    texts: [{ text: "打开", confidence: 0.93, bounds: { x: -767, y: 66, width: 40, height: 12 }, point: { x: -747, y: 72 } }],
    shapes: [{ kind: "rectangle", label: "打开", bounds: { x: -788, y: 55, width: 90, height: 36 }, point: { x: -743, y: 73 } }],
    truncated: false,
  });
});

it("finds an unlabeled cross without borrowing an adjacent label", () => {
  const image = canvas(80, 60, 230);
  image.fill(20, 13, 5, 19, 48);
  image.fill(13, 20, 19, 5, 48);
  const line = { text: "Add", confidence: 0.86, box: { x: 34, y: 16, width: 28, height: 13 } };
  expect(analyzeDesktopRegions(image, [line], origin).shapes).toEqual([
    { kind: "icon", bounds: { x: -787, y: 58, width: 19, height: 19 }, point: { x: -778, y: 67 } },
  ]);
});

it("clips text boxes to the crop before offsetting, deduplicates and sorts", () => {
  const image = canvas(100, 80, 22);
  const line = { text: "末行", confidence: 0.89, box: { x: 91.4, y: 70.5, width: 40, height: 20 } };
  const lines = [
    line, { ...line, confidence: 0.77 },
    { text: "首行", confidence: 1, box: { x: -8, y: -1, width: 25, height: 10 } },
    { ...line, box: { x: 100, y: 0, width: 12, height: 10 } },
  ];
  expect(analyzeDesktopRegions(image, lines, origin)).toEqual({
    texts: [
      { text: "首行", confidence: 1, bounds: { x: -800, y: 45, width: 17, height: 9 }, point: { x: -792, y: 49 } },
      { text: "末行", confidence: 0.89, bounds: { x: -709, y: 115, width: 9, height: 10 }, point: { x: -705, y: 120 } },
    ],
    shapes: [], truncated: false,
  });
});

it("assigns a label only to its closest enclosing rectangle", () => {
  const image = canvas(220, 120, 255);
  image.fill(8, 8, 185, 94, 42);
  image.fill(9, 9, 183, 92, 255);
  image.fill(80, 52, 75, 32, 95);
  const line = { text: "Save", confidence: 0.9, box: { x: 96, y: 60, width: 37, height: 14 } };
  const { shapes } = analyzeDesktopRegions(image, [line], origin);
  expect(shapes).toHaveLength(2);
  expect(shapes.map(shape => shape.label)).toEqual([undefined, "Save"]);
});

it("keeps thin native-pixel lines in a large capture even between sampling positions", () => {
  const image = canvas(2560, 1440, 245);
  image.fill(101, 107, 101, 41, 72);
  image.fill(102, 108, 99, 39, 245);
  const { shapes } = analyzeDesktopRegions(image, [], { x: 0, y: 0 });
  expect(shapes).toHaveLength(1);
  expect(shapes[0].kind).toBe("rectangle");
  expect(Math.abs(shapes[0].bounds.x - 101)).toBeLessThanOrEqual(2);
  expect(Math.abs(shapes[0].bounds.height - 41)).toBeLessThanOrEqual(2);
});

it("recognizes a partially cropped rectangle from its three visible sides", () => {
  const image = canvas(100, 60, 220);
  image.fill(0, 6, 72, 36, 45);
  image.fill(0, 8, 70, 32, 220);
  const line = { text: "OK", confidence: 0.94, box: { x: 14, y: 15, width: 22, height: 15 } };
  expect(analyzeDesktopRegions(image, [line], origin).shapes).toEqual([
    { kind: "rectangle", label: "OK", bounds: { x: -800, y: 51, width: 72, height: 36 }, point: { x: -764, y: 69 } },
  ]);
});

it("does not infer four sides from a graphic touching all four crop edges", () => {
  const image = canvas(180, 180, 230);
  for (let x = 0; x < image.width; x++) {
    image.fill(x, x, 1, 1, 64);
    image.fill(x, image.height - x - 1, 1, 1, 64);
  }
  expect(analyzeDesktopRegions(image, [], origin).shapes).toEqual([]);
});

it("reports truncated lists on dense input and produces stable output", () => {
  const image = canvas(800, 500, 255);
  for (let y = 5; y < 480; y += 22) {
    for (let x = 3; x < 760; x += 25) image.fill(x, y, 15, 14, 40);
  }
  const first = analyzeDesktopRegions(image, [], origin);
  expect(first.truncated).toBe(true);
  expect(first.shapes.length).toBeGreaterThan(0);
  expect(first.shapes.length).toBeLessThan(300);
  expect(analyzeDesktopRegions(image, [], origin)).toEqual(first);
});
