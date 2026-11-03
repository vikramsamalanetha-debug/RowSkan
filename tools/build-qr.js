// Bundles lib/qr (MIT, from qrcode-terminal) into one browser file: app/qr.js  ->  window.RowSkanQR.svg(text)
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'lib', 'qr'), files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
let out = '/* QR code encoder (MIT, Kazuhiko Arase / qrcode-terminal), bundled for the browser by tools/build-qr.js */\n(function(){\nvar defs={},cache={};\nfunction req(n){n=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(cache[n])return cache[n].exports;var m=cache[n]={exports:{}};defs[n](m,m.exports,req);return m.exports}\n';
for (const f of files) out += 'defs[' + JSON.stringify(f.replace(/\.js$/, '')) + ']=function(module,exports,require){\n' + fs.readFileSync(path.join(dir, f), 'utf8') + '\n};\n';
out += `var QRCode=req("index"),Level=req("QRErrorCorrectLevel");
window.RowSkanQR={svg:function(text){var q=new QRCode(0,Level.M);q.addData(text);q.make();var n=q.getModuleCount(),m=4,size=n+m*2,d="";
for(var r=0;r<n;r++)for(var c=0;c<n;c++)if(q.isDark(r,c))d+="M"+(c+m)+" "+(r+m)+"h1v1h-1z";
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+size+' '+size+'" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="'+d+'" fill="#111"/></svg>'}};
})();\n`;
fs.writeFileSync(path.join(__dirname, '..', 'app', 'qr.js'), out);
console.log('app/qr.js', out.length, 'bytes');
