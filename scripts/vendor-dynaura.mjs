// Copy the official vanilla adapter and no-font CSS to the Worker's static assets.
// Keep the MIT license alongside the files; no CDN or build-time framework is required.
import { copyFile, mkdir, readdir } from 'node:fs/promises';
const source = 'node_modules/dynaura/dist';
const target = 'public/vendor/dynaura';
await mkdir(target, { recursive: true });
for (const name of await readdir(source)) {
  if (name === 'vanilla.js' || name === 'styles-no-font.css' || /^chunk-.*\.js$/.test(name)) {
    await copyFile(`${source}/${name}`, `${target}/${name}`);
  }
}
await copyFile('node_modules/dynaura/LICENSE', `${target}/LICENSE`);
