// IndexedDB cache of the extracted files (page and worker), docs/tech/WEB.md.
// Database "zelda3-2-rom": store "files" (relative path -> Uint8Array), store "meta":
//   "state" {key, sha1, rom_version, rom_name, count, bytes, seconds, date}  written last
//   "rom"   {name, data}  the player's ROM, kept to re-extract after an update of the site
'use strict';

const ZStore = (() => {
	const DB = 'zelda3-2-rom';

	function req(r) {
		return new Promise((resolve, reject) => {
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error);
		});
	}

	function done(tx) {
		return new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error || new Error('transaction annulée'));
		});
	}

	function open() {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => {
			r.result.createObjectStore('files');
			r.result.createObjectStore('meta');
		};
		return req(r);
	}

	async function getMeta(db, key) {
		return req(db.transaction('meta').objectStore('meta').get(key));
	}

	async function putMeta(db, key, value) {
		const tx = db.transaction('meta', 'readwrite');
		tx.objectStore('meta').put(value, key);
		return done(tx);
	}

	async function putFiles(db, entries) {
		const tx = db.transaction('files', 'readwrite');
		const st = tx.objectStore('files');
		for (const [path, data] of entries) {
			st.put(data, path);
		}
		return done(tx);
	}

	// Calls fn(path, Uint8Array) for every stored file.
	async function eachFile(db, fn) {
		const tx = db.transaction('files');
		const st = tx.objectStore('files');
		const [keys, values] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
		for (let i = 0; i < keys.length; i++) {
			fn(keys[i], values[i]);
		}
		return keys.length;
	}

	// Removes the extracted files and the state (keeps the ROM unless `all`).
	async function clear(db, all) {
		const tx = db.transaction(['files', 'meta'], 'readwrite');
		tx.objectStore('files').clear();
		if (all) {
			tx.objectStore('meta').clear();
		} else {
			tx.objectStore('meta').delete('state');
		}
		return done(tx);
	}

	return { open, getMeta, putMeta, putFiles, eachFile, clear };
})();
self.ZStore = ZStore;
