/** Cached thumbnails only; the renderer never fetches the provider directly. */
export type PhotoFlowImage = {
  id: string;
  src: string;
  portrait: boolean;
  position: string;
  author?: string;
  sourceUrl?: string;
};
