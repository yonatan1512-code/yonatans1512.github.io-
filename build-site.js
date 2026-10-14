// Builds the public website (GitHub Pages) into dist/: index.html, the stylesheets and scripts it loads, and only the images the app uses.
// The server, the old site (legacy/), packages and other project files are left out.
//   node build-site.js        (or: npm run build)
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const copy = rel => {
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), to);
};

// empty dist/ but keep its .git folder: dist/ is the repository that GitHub Pages publishes
fs.mkdirSync(OUT, { recursive: true });
fs.readdirSync(OUT).filter(n => n !== '.git').forEach(n => fs.rmSync(path.join(OUT, n), { recursive: true, force: true }));
// tells GitHub Pages to serve the files as they are (no Jekyll processing)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const files = ['index.html']
  .concat([...html.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)">/g)].map(m => m[1]))
  .concat([...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]));

// images: the photos the pages use, and one thumbnail for every verified video
const misc = fs.readFileSync(path.join(ROOT, 'js', 'cm.data.misc.js'), 'utf8');
const videoIds = [...misc.matchAll(/^ {2}'([\w-]{11})': \[/gm)].map(m => m[1]);
files.push('images/hero.webp', 'images/night.webp', 'images/crowd.webp');
videoIds.forEach(id => files.push('images/thumbs/' + id + '.jpg'));

const missing = files.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) { console.error('Missing files:\n' + missing.join('\n')); process.exit(1); }
files.forEach(copy);
const size = files.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`dist/ ready: ${files.length} files, ${(size / 1024 / 1024).toFixed(1)} MB`);
