// Only use OCR evidence produced by the local worker for this exact capture.
// Overlapping labels do not establish which text the model meant to click.
function observedLabel(frame, click) {
  if (!frame || !click.observationId || frame.observationId !== click.observationId || frame.windowId !== click.windowId)
    return undefined;
  const hits = frame.texts.filter(({bounds:b}) => b && [b.x,b.y,b.width,b.height].every(Number.isSafeInteger) &&
    click.x >= b.x && click.y >= b.y && click.x < b.x+b.width && click.y < b.y+b.height);
  if (hits.length !== 1) return undefined;
  const [hit] = hits;
  const normalize = text => text.trim().replace(/\s+/g," ");
  // A labelled outline may span several OCR lines. Its first line alone
  // cannot verify the complete target.
  const largerLabel = frame.shapes?.some(({bounds:b,label}) => label && hit.text &&
    click.x >= b.x && click.y >= b.y && click.x < b.x+b.width && click.y < b.y+b.height &&
    normalize(label) !== normalize(hit.text));
  return largerLabel ? undefined : hit.bounds;
}
module.exports = {observedLabel};
