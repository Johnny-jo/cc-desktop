const sources = import.meta.glob<string>("../assets/photo-flow/*.jpg", {
  eager: true, query: "?url", import: "default",
});

// Mix subjects from the first screen onward instead of appending all portraits
// after the landscape collection. Portraits keep their faces above the crop.
export const PHOTO_FLOW_IMAGES = [
  "01-lake", "11-portrait-woman", "12-architecture", "04-coast",
  "15-flowers", "14-portrait-man", "02-mountain", "13-coffee",
  "16-abstract", "03-forest", "05-valley", "08-horizon",
  "09-wildlife", "07-woodland", "10-nightfall", "06-wilderness",
].map(name => ({
  src: sources[`../assets/photo-flow/${name}.jpg`],
  portrait: name.includes("portrait"),
  position: name.includes("portrait") ? "50% 32%" : "50% 50%",
}));
