// Regenerates assets/ from the SVG below. Needs Playwright with Chromium
// (`npm i -D playwright && npx playwright install chromium`); the generated
// files are checked in, so you only need this to change the artwork.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

// A wall unit with air coming out of it, on a 16-unit grid.
const glyph = (stroke, width, air = true) => `
  <g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.6" y="2.6" width="12.8" height="6" rx="1.9"/>
    <path d="M4.4 6.3h7.2"/>
    ${air ? '<path d="M4.7 11.2c-.5.9-.5 1.7 0 2.5M8 11.2v2.5M11.3 11.2c.5.9.5 1.7 0 2.5"/>' : ""}
  </g>`;

// Menu bar: the unit alone when it is off, with air coming out when it runs.
// The idle unit sits lower so it stays optically centred without the air lines.
const trayOn = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${glyph("#000", 1.25)}</svg>`;
const trayOff = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><g transform="translate(0 2.4)" opacity="0.62">${glyph("#000", 1.25, false)}</g></svg>`;

const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1b63d8"/><stop offset="1" stop-color="#4fb2f2"/>
  </linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#g)"/>
  <g transform="translate(232 222) scale(35)">${glyph("#fff", 1.15)}</g>
</svg>`;

const browser = await chromium.launch();
async function png(svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>*{margin:0}html,body{background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

for (const [name, svg] of [["trayOn", trayOn], ["trayOff", trayOff]]) {
  writeFileSync(`assets/${name}Template.png`, await png(svg, 16));
  writeFileSync(`assets/${name}Template@2x.png`, await png(svg, 32));
  writeFileSync(`assets/${name}Template@3x.png`, await png(svg, 48));
}

// .icns is a list of [type, length, PNG] chunks behind an 8-byte header.
const chunks = [];
for (const [type, size] of [["ic11", 32], ["ic12", 64], ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024]]) {
  const data = await png(app, size);
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  chunks.push(head, data);
  if (size === 512) writeFileSync("assets/icon.png", data);
}
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
writeFileSync("assets/icon.icns", Buffer.concat([header, body]));

await browser.close();
console.log("assets written");
