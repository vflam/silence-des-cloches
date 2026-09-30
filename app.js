// Page of the web version (docs/tech/WEB.md): ROM choice and check, extraction in a worker
// (worker.js, Pyodide), cache in IndexedDB (store.js), then the Godot game reads the files
// from /rom (RomAssets.WEB_ROOT, passed with --rom-assets).
'use strict';

(() => {
	const $ = (id) => document.getElementById(id);
	const ui = {
		file: $('file'), drop: $('drop'), pick: $('pick'), check: $('check'), start: $('start'),
		work: $('work'), label: $('work-label'), bar: $('work-bar'), detail: $('work-detail'),
		error: $('error'), reset: $('reset'), versions: $('versions'), canvas: $('canvas'),
	};

	// Seconds of each stage in headless Chromium (JP 1.0 ROM, ~4 min in all): weights of the
	// progress bar (web/test/browser_test.py reports them as stage_start_seconds).
	const STAGES = {
		palettes: ['Palettes', 1], gfx: ['Graphismes', 1.5], overworld: ['Monde extérieur', 13],
		audio: ['Musiques et bruitages', 20], sprites: ['Personnages, ennemis et objets', 160],
		sprites_zz_cleanup: ['Retouches des sprites', 0.2], ui: ['Interface', 0.2],
		underworld: ['Intérieurs', 18], underworld_custom: ['Nos salles', 1.5],
		zz_maps: ['Nos cartes', 24], store: ['Enregistrement dans le navigateur', 4],
	};
	const ORDER = Object.keys(STAGES);
	const TOTAL = ORDER.reduce((s, k) => s + STAGES[k][1], 0);

	let build = null;
	let worker = null;
	let rom = null; // {name, data: Uint8Array, info}
	let ready = null; // cache state usable as is
	let stale = null; // {rom} stored ROM whose extraction is out of date

	function show(el, on) {
		el.hidden = !on;
	}

	function setCheck(text, cls) {
		ui.check.textContent = text;
		ui.check.className = cls || '';
	}

	function fail(message) {
		ui.error.textContent = message;
		show(ui.error, true);
		show(ui.work, false);
		ui.start.disabled = false;
		console.error(message);
	}

	function cacheKey() {
		return `extract-v${build.extractor_version}-${build.extract_hash}`;
	}

	function getWorker() {
		if (!worker) {
			worker = new Worker(`worker.js?v=${build.extract_hash}`, { type: 'module' });
		}
		return worker;
	}

	function stopWorker() {
		if (worker) {
			worker.terminate();
			worker = null;
		}
	}

	// One request to the worker; `onProgress` gets the progress / status messages.
	function ask(msg, onProgress, transfer) {
		return new Promise((resolve, reject) => {
			const w = getWorker();
			w.onmessage = (ev) => {
				const m = ev.data;
				if (m.type === 'error') {
					reject(new Error(m.message));
				} else if (m.type === 'progress' || m.type === 'status') {
					if (onProgress) {
						onProgress(m);
					}
				} else if (m.type === (msg.type === 'check' ? 'checked' : 'done')) {
					resolve(m);
				} // else: 'booted' of the early boot request
			};
			w.onerror = (ev) => reject(new Error(ev.message || 'erreur du worker'));
			w.postMessage(msg, transfer || []);
		});
	}

	function fmtBytes(n) {
		return n > 1e6 ? `${(n / 1e6).toFixed(0)} Mo` : `${Math.round(n / 1e3)} ko`;
	}

	// --- ROM choice ------------------------------------------------------------------------
	async function onFile(file) {
		await started; // a ROM dropped before the page finished loading build.json
		if (!file) {
			return;
		}
		show(ui.error, false);
		show(ui.start, false);
		rom = null;
		if (!/\.(sfc|smc|zip)$/i.test(file.name)) {
			setCheck(`« ${file.name} » : il faut un fichier .sfc, .smc ou .zip.`, 'bad');
			return;
		}
		if (file.size > 16 * 1024 * 1024) {
			setCheck(`« ${file.name} » est trop gros pour être une ROM de Super Nintendo.`, 'bad');
			return;
		}
		setCheck(`Vérification de « ${file.name} »…`);
		const data = new Uint8Array(await file.arrayBuffer());
		let res;
		try {
			res = await ask({ type: 'check', blob: data }, (m) => {
				if (m.text) {
					setCheck(`Vérification de « ${file.name} » : ${m.text}`);
				}
			});
		} catch (e) {
			setCheck('', '');
			fail(`La vérification a échoué : ${e.message}`);
			return;
		}
		const info = res.info;
		if (info.supported) {
			rom = { name: file.name, data, info };
			setCheck(`✔ ${info.name} : compatible.`, 'ok');
			ui.start.textContent = 'Commencer';
			show(ui.start, true);
			ui.start.focus();
		} else if (info.zelda) {
			setCheck(`✘ ${info.name} : cette version n’est pas encore prise en charge (SHA-1 ${info.sha1}).`, 'bad');
		} else {
			setCheck(`✘ « ${file.name} » n’est pas une ROM de A Link to the Past / Kamigami no Triforce. Versions acceptées : ${build.rom_versions.map((v) => v.name).join(', ')}.`, 'bad');
		}
	}

	ui.file.addEventListener('change', () => onFile(ui.file.files[0]));
	ui.drop.addEventListener('dragover', (ev) => {
		ev.preventDefault();
		ui.drop.classList.add('over');
	});
	ui.drop.addEventListener('dragleave', () => ui.drop.classList.remove('over'));
	ui.drop.addEventListener('drop', (ev) => {
		ev.preventDefault();
		ui.drop.classList.remove('over');
		onFile(ev.dataTransfer.files[0]);
	});

	// --- extraction ------------------------------------------------------------------------
	function progressView() {
		let stage = null;
		let stageStart = 0;
		let done = 0; // weight of the finished stages
		let timer = null;
		const t0 = performance.now();
		const paint = (frac, detail) => {
			ui.bar.style.width = `${Math.min(100, (100 * frac)).toFixed(1)}%`;
			const s = Math.round((performance.now() - t0) / 1000);
			ui.detail.textContent = `${Math.floor(100 * Math.min(1, frac))} % · ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s${detail ? ` · ${detail}` : ''}`;
		};
		const tick = () => {
			if (!stage || !STAGES[stage]) {
				paint(done / TOTAL);
				return;
			}
			// inside a stage: creep towards its end (63 % after its expected time, never reached)
			const w = STAGES[stage][1];
			const el = (performance.now() - stageStart) / 1000;
			paint((done + w * (1 - Math.exp(-el / Math.max(1, w)))) / TOTAL);
		};
		timer = setInterval(tick, 250);
		return {
			on(m) {
				if (m.type === 'status') {
					ui.label.textContent = m.text || ui.label.textContent;
					return;
				}
				if (m.stage === 'store' && m.total) {
					paint((TOTAL - STAGES.store[1] * (1 - m.done / m.total)) / TOTAL, `${m.done} / ${m.total} fichiers`);
					return;
				}
				if (m.stage !== stage) {
					(window.zelda3Stages = window.zelda3Stages || {})[m.stage] = m.t; // start times (s), for tests
					if (stage && STAGES[stage]) {
						done += STAGES[stage][1];
					}
					stage = m.stage;
					stageStart = performance.now();
					ui.label.textContent = STAGES[stage] ? `${STAGES[stage][0]}…` : ui.label.textContent;
				}
				tick();
			},
			stop() {
				clearInterval(timer);
			},
		};
	}

	async function extract(r) {
		show(ui.pick, false);
		show(ui.start, false);
		show(ui.work, true);
		ui.label.textContent = 'Préparation…';
		const view = progressView();
		const meta = {
			key: cacheKey(), sha1: r.info.sha1, rom_version: r.info.id, rom_title: r.info.name, rom_name: r.name,
		};
		try {
			const res = await ask({ type: 'extract', blob: r.data, meta }, (m) => view.on(m));
			view.stop();
			stopWorker(); // frees Python's memory before the game starts
			console.log(`extraction : ${res.state.seconds.toFixed(1)} s, ${res.state.count} fichiers, ${res.state.bytes} octets`);
			window.zelda3Extraction = res.state;
			return res.state;
		} catch (e) {
			view.stop();
			stopWorker();
			throw e;
		}
	}

	// --- game --------------------------------------------------------------------------------
	async function startGame() {
		show(ui.work, true);
		ui.label.textContent = 'Démarrage du jeu…';
		ui.bar.style.width = '0%';
		ui.detail.textContent = '';
		const engine = new Engine(GODOT_CONFIG);
		const db = await ZStore.open();
		const n = await ZStore.eachFile(db, (path, data) => engine.preloadFile(data, `/rom/${path}`));
		db.close();
		if (!n) {
			throw new Error('aucun fichier extrait dans le navigateur');
		}
		const args = ['--rom-assets=/rom'];
		if (build.custom_pack) { // our own assets (game/assets/custom), see RomAssets
			await engine.preloadFile(build.custom_pack, '/custom.pck');
			args.push('--pack=/custom.pck');
		}
		document.body.classList.add('playing');
		show(ui.canvas, true);
		await engine.startGame({
			args,
			onProgress(current, total) {
				if (total > 0) {
					ui.bar.style.width = `${(100 * current / total).toFixed(1)}%`;
				}
			},
		});
		ui.canvas.focus();
		window.zelda3Started = true;
	}

	ui.start.addEventListener('click', async () => {
		ui.start.disabled = true;
		show(ui.error, false);
		try {
			if (!ready) {
				let r = rom;
				if (!r) { // ROM kept from a previous visit: check it again with this version
					show(ui.work, true);
					ui.label.textContent = 'Vérification de la ROM…';
					const res = await ask({ type: 'check', blob: stale.data }, (m) => {
						ui.label.textContent = m.text || ui.label.textContent;
					});
					if (!res.info.supported) {
						throw new Error(`${res.info.name} : version non prise en charge par cette version du jeu`);
					}
					r = { name: stale.name, data: stale.data, info: res.info };
				}
				await extract(r);
			}
			await startGame();
		} catch (e) {
			document.body.classList.remove('playing');
			show(ui.canvas, false);
			show(ui.pick, true);
			fail(`Erreur : ${e.message}`);
		}
	});

	ui.reset.addEventListener('click', async (ev) => {
		ev.preventDefault();
		if (!confirm('Effacer la ROM et les fichiers extraits gardés dans ce navigateur ?')) {
			return;
		}
		const db = await ZStore.open();
		await ZStore.clear(db, true);
		db.close();
		location.reload();
	});

	// --- start-up ------------------------------------------------------------------------------
	async function init() {
		const missing = Engine.getMissingFeatures({ threads: GODOT_THREADS_ENABLED });
		if (missing.length) {
			fail(`Votre navigateur ne peut pas lancer ce jeu :\n${missing.join('\n')}`);
			show(ui.pick, false);
			return;
		}
		build = await (await fetch('build.json', { cache: 'no-cache' })).json();
		ui.versions.textContent = build.rom_versions.map((v) => v.name).join(', ');
		const db = await ZStore.open();
		const state = await ZStore.getMeta(db, 'state');
		const saved = await ZStore.getMeta(db, 'rom');
		db.close();
		if (state || saved) {
			show(ui.reset, true);
		}
		if (state && state.key === cacheKey()) {
			ready = state;
			show(ui.pick, false);
			setCheck(`✔ Jeu prêt (${state.rom_title}, ${state.count} fichiers, ${fmtBytes(state.bytes)} gardés dans ce navigateur).`, 'ok');
			show(ui.start, true);
			return;
		}
		if (saved && saved.data) {
			stale = { name: saved.name, data: saved.data };
			show(ui.pick, false);
			setCheck('Le jeu a été mis à jour : les graphismes et les sons doivent être extraits à nouveau de votre ROM (déjà gardée dans ce navigateur).', 'ok');
			ui.start.textContent = 'Extraire et commencer';
			show(ui.start, true);
			return;
		}
		getWorker().postMessage({ type: 'boot' }); // loads Python while the player looks for the ROM
	}

	const started = init().catch((e) => fail(`Erreur au démarrage : ${e.message}`));
})();
