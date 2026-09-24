// 把多个尺寸的 PNG 打包成 Windows .ico (PNG 压缩帧, Vista+ 支持)
"use strict";
const fs = require("fs");
const path = require("path");

const sizes = [16, 32, 48, 64, 256];
const pngs = sizes.map((s) => fs.readFileSync(path.join("build", `icon-${s}.png`)));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

let offset = 6 + pngs.length * 16;
const entries = pngs.map((png, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 0); // width (0 = 256)
  e.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(png.length, 8); // data size
  e.writeUInt32LE(offset, 12); // data offset
  offset += png.length;
  return e;
});

fs.writeFileSync(path.join("build", "icon.ico"), Buffer.concat([header, ...entries, ...pngs]));
console.log("icon.ico written:", fs.statSync(path.join("build", "icon.ico")).size, "bytes");
