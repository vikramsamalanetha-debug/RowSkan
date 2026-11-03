// Copies the web app (../app) into www/ for the phone wrapper. Zero dependencies.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'app'), dst = path.join(__dirname, 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
// the phone app shows a link/QR for adding it to an account; point links at the public web app
const cfgFile = path.join(dst, 'config.js'); let cfg = fs.readFileSync(cfgFile, 'utf8');
const appUrl = process.env.ROWSKAN_APP_URL || 'https://vikramsamalanetha-debug.github.io/RowSkan-demo-1/';
cfg = cfg.replace("appUrl: ''", "appUrl: '" + appUrl + "'"); fs.writeFileSync(cfgFile, cfg);
fs.rmSync(path.join(dst, 'sw.js'), { force: true }); // the installed app already works offline
console.log('web app copied to', dst, '(appUrl ' + appUrl + ')');
