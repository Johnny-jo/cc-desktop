/** Synthetic documents only; no user files are used by PDF regression tests. */
export function pdfFixture(pages: string[], chinese = false): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "",
    chinese ? "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>] >>"
      : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: number[] = [];
  for (const text of pages) {
    const id = objects.length + 1;
    kids.push(id);
    const encoded = chinese ? `<${Array.from(text).map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}>`
      : `(${text.replace(/[\\()]/g, "\\$&")})`;
    const stream = text ? `BT /F1 12 Tf 72 720 Td ${encoded} Tj ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export function mixedPdfFixture(pages: Array<{
  text?: string;
  image?: { jpeg: Buffer; width: number; height: number };
}>): Buffer {
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.alloc(0),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")];
  const kids: number[] = [];
  for (const page of pages) {
    const id = objects.length + 1;
    kids.push(id);
    const image = page.image;
    const text = (page.text ?? "").replace(/[\\()]/g, "\\$&");
    const stream = (image ? "q 595 0 0 842 0 0 cm /Im0 Do Q\n" : "") +
      (text ? `BT /F1 12 Tf 72 780 Td (${text}) Tj ET` : "");
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Im0 ${id + 2} 0 R >>` : ""} >> /Contents ${id + 1} 0 R >>`),
      Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
    if (image) objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`), image.jpeg, Buffer.from("\nendstream")]));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk); length += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
