// Extraction worker (docs/tech/WEB.md): runs tools/rom_extract/extract.py in Pyodide, fed with
// the ROM chosen by the player, and stores the extracted files in IndexedDB (store.js).
// Nothing leaves the browser.
//
// Messages in:  {type: 'check', blob}           -> {type: 'checked', info}
//               {type: 'extract', blob, key}     -> {type: 'progress', ...}* then {type: 'done', ...}
// Any failure:  {type: 'error', message}
// Module worker: Pyodide (0.28+ / 314.x) no longer loads in classic workers.
import './store.js';

let build = null; // build.json
let pyodide = null;
let booting = null;
const tools = {}; // name -> {code, module}

function post(msg) {
	self.postMessage(msg);
}

function status(text) {
	post({ type: 'status', text });
}

async function fetchBytes(url) {
	const r = await fetch(url);
	if (!r.ok) {
		throw new Error(`${url} : ${r.status}`);
	}
	return new Uint8Array(await r.arrayBuffer());
}

// --- C tools (tools/room_render, tools/spc_render) compiled to WebAssembly -----------------
// Each run gets a fresh instance (the C code keeps global state), created synchronously
// (-sWASM_ASYNC_COMPILATION=0 + wasmBinary) so that Python can call it like a subprocess.
async function loadTool(name) {
	const [code, wasm] = await Promise.all([
		fetch(`tools/${name}.js?v=${build.extract_hash}`).then((r) => r.text()),
		fetchBytes(`tools/${name}.wasm?v=${build.extract_hash}`),
	]);
	tools[name] = { factory: new Function('Module', code), wasm };
}

self.zelda3Native = function (name, args, inputs, outputs) {
	const tool = tools[name];
	if (!tool) {
		throw new Error(`outil ${name} absent`);
	}
	const out = [];
	const err = [];
	const Module = {
		noInitialRun: true,
		print: (s) => out.push(s),
		printErr: (s) => err.push(s),
		wasmBinary: tool.wasm,
	};
	tool.factory(Module);
	const FS = Module.FS;
	const dirOf = (p) => p.substring(0, p.lastIndexOf('/')) || '/';
	for (const [path, data] of Object.entries(inputs)) {
		FS.mkdirTree(dirOf(path));
		FS.writeFile(path, data);
	}
	for (const path of outputs) {
		FS.mkdirTree(dirOf(path));
	}
	let code = 0;
	try {
		code = Module.callMain(Array.from(args));
	} catch (e) {
		if (e && e.name === 'ExitStatus') {
			code = e.status;
		} else {
			err.push(String(e && e.stack || e));
			code = 134;
		}
	}
	const files = {};
	for (const path of outputs) {
		try {
			files[path] = FS.readFile(path);
		} catch (e) {
			// not written: the caller sees the return code / missing file
		}
	}
	return { code, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: err.join('\n'), files };
};

// --- Python ----------------------------------------------------------------------------------
const DRIVER = `
import sys, os
sys.path.insert(0, "/proj/tools/rom_extract")
os.chdir("/proj")
import rom as _rom

def _bytes(blob):
    return blob.to_bytes() if hasattr(blob, "to_bytes") else bytes(blob)

def zelda3_check(blob):
    data = _bytes(blob)
    try:
        if data[:4] == b"PK\\x03\\x04":
            data = _rom.rom_from_zip(data)
    except Exception as e:
        return {"supported": False, "zelda": False, "name": f"fichier illisible ({e})", "sha1": ""}
    return _rom.identify(_rom.strip_header(data))

def zelda3_extract(blob, progress):
    import extract
    data = _bytes(blob)
    path = "/input/rom.zip" if data[:4] == b"PK\\x03\\x04" else "/input/rom.sfc"
    os.makedirs("/input", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    extract.progress = lambda stage: progress(stage)
    code = extract.main(["--rom", path, "--no-previews"])
    os.remove(path)
    return code
`;

async function boot() {
	if (booting) {
		return booting;
	}
	booting = (async () => {
		build = await (await fetch('build.json', { cache: 'no-cache' })).json();
		status('Chargement de Python (Pyodide)…');
		const { loadPyodide } = await import(`${build.pyodide_url}pyodide.mjs`);
		pyodide = await loadPyodide({ indexURL: build.pyodide_url });
		status('Chargement de numpy et Pillow…');
		await pyodide.loadPackage(['numpy', 'pillow'], { messageCallback: () => {} });
		status('Chargement de l’extracteur…');
		const [sources] = await Promise.all([
			fetchBytes(build.sources),
			loadTool('room_render'),
			loadTool('spc_render'),
		]);
		pyodide.unpackArchive(sources, 'zip', { extractDir: '/proj' });
		pyodide.runPython(DRIVER);
		status('');
	})();
	return booting;
}

function walk(FS, dir, base, out) {
	for (const name of FS.readdir(dir)) {
		if (name === '.' || name === '..') {
			continue;
		}
		const p = `${dir}/${name}`;
		const rel = base ? `${base}/${name}` : name;
		const st = FS.stat(p);
		if (FS.isDir(st.mode)) {
			walk(FS, p, rel, out);
		} else if (name !== '.gdignore') {
			out.push([p, rel]);
		}
	}
	return out;
}

async function extract(blob, meta) {
	await boot();
	const lines = [];
	pyodide.setStdout({ batched: (s) => lines.push(s) });
	pyodide.setStderr({ batched: (s) => lines.push(s) });
	const t0 = performance.now();
	const progress = (stage) => post({ type: 'progress', stage, t: (performance.now() - t0) / 1000 });
	const run = pyodide.globals.get('zelda3_extract');
	const code = run(blob, progress);
	run.destroy();
	const seconds = (performance.now() - t0) / 1000;
	if (code !== 0) {
		throw new Error(`l’extraction a échoué (code ${code}) :\n${lines.slice(-15).join('\n')}`);
	}
	post({ type: 'progress', stage: 'store', t: seconds });
	const FS = pyodide.FS;
	const root = '/proj/game/assets/rom';
	const files = walk(FS, root, '', []);
	let bytes = 0;
	const db = await ZStore.open();
	await ZStore.clear(db);
	const BATCH = 64;
	for (let i = 0; i < files.length; i += BATCH) {
		const batch = files.slice(i, i + BATCH).map(([p, rel]) => {
			const data = FS.readFile(p);
			bytes += data.length;
			return [rel, data];
		});
		await ZStore.putFiles(db, batch);
		post({ type: 'progress', stage: 'store', done: Math.min(i + BATCH, files.length), total: files.length });
	}
	for (const [p] of files) {
		FS.unlink(p);
	}
	const state = Object.assign({}, meta, { count: files.length, bytes, seconds, date: new Date().toISOString() });
	await ZStore.putMeta(db, 'rom', { name: meta.rom_name, data: blob });
	await ZStore.putMeta(db, 'state', state);
	db.close();
	return { state, log: lines };
}

self.onmessage = async (ev) => {
	const msg = ev.data;
	try {
		if (msg.type === 'boot') {
			await boot();
			post({ type: 'booted' });
		} else if (msg.type === 'check') {
			await boot();
			const check = pyodide.globals.get('zelda3_check');
			const res = check(msg.blob);
			const info = res.toJs({ dict_converter: Object.fromEntries });
			res.destroy();
			check.destroy();
			post({ type: 'checked', info });
		} else if (msg.type === 'extract') {
			const res = await extract(msg.blob, msg.meta);
			post({ type: 'done', state: res.state, log: res.log });
		}
	} catch (e) {
		post({ type: 'error', message: String(e && e.message || e), stack: String(e && e.stack || '') });
	}
};
