const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Serve Leaflet from our own server (run: npm install leaflet)
// so the map works even if unpkg/jsDelivr CDN is blocked
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// ---------------- ROUTE CACHE ----------------
// Every route that is found once is saved in routes-cache.json.
// Next time (even with bad internet) the same route loads from this file.
const CACHE_FILE = path.join(__dirname, 'routes-cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { cache = {}; }
function saveCache() {
    fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), () => {});
}

async function fetchJSON(url, ms = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'TransitGo-Student-Project/1.0' } // Nominatim needs a User-Agent
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// ---------------- GEOCODE API ----------------
// GET /api/geocode?q=Lokhra  ->  { lat, lng }
// Tries 3 different searches, because one search engine alone often misses places
const GUWAHATI_BOX = { minLat: 26.0, maxLat: 26.3, minLng: 91.45, maxLng: 92.0 };
const inGuwahati = (lat, lng) =>
    lat >= GUWAHATI_BOX.minLat && lat <= GUWAHATI_BOX.maxLat && lng >= GUWAHATI_BOX.minLng && lng <= GUWAHATI_BOX.maxLng;

async function searchPlace(q) {
    const enc = encodeURIComponent;
    const box = `${GUWAHATI_BOX.minLng},${GUWAHATI_BOX.maxLat},${GUWAHATI_BOX.maxLng},${GUWAHATI_BOX.minLat}`;
    const attempts = [
        // 1) Nominatim, only inside Guwahati
        async () => {
            const d = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=1&viewbox=${box}&bounded=1&q=${enc(q)}`);
            return d[0] && { lat: +d[0].lat, lng: +d[0].lon };
        },
        // 2) Nominatim with ", Guwahati" added
        async () => {
            const d = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${enc(q + ', Guwahati')}`);
            return d[0] && { lat: +d[0].lat, lng: +d[0].lon };
        },
        // 3) Photon (better at spelling mistakes / partial names), biased to Guwahati
        async () => {
            const d = await fetchJSON(`https://photon.komoot.io/api/?limit=1&lat=26.14&lon=91.74&q=${enc(q)}`);
            const f = d.features && d.features[0];
            return f && { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
        }
    ];
    for (const attempt of attempts) {
        try {
            const r = await attempt();
            if (r && inGuwahati(r.lat, r.lng)) return r;
        } catch (e) {
            console.error('Geocode attempt failed:', e.message);
        }
    }
    return null;
}

app.get('/api/geocode', async (req, res) => {
    const q = (req.query.q || '').trim();
    const key = 'geo:' + q.toLowerCase();
    if (cache[key]) return res.json(cache[key]);

    let r = null;
    for (const v of queryVariants(q)) {
        r = await searchPlace(v);
        if (r) break;
    }
    if (!r) return res.status(404).json({ error: `"${q}" not found in Guwahati` });
    cache[key] = r;
    saveCache();
    res.json(r);
});

// ---------------- SUGGEST API (dropdown while typing) ----------------
// GET /api/suggest?q=bala  ->  [{ name, area, lat, lng }, ...]  (only places in Guwahati)
const suggestCache = {};

function uniqueJoin(parts) {
    return [...new Set(parts.filter(Boolean))].join(', ');
}

// "hatigaon , sewali path"  ->  ["hatigaon , sewali path", "hatigaon sewali path", "sewali path", "hatigaon"]
// Small lanes are often missing on OpenStreetMap, so we also try smaller pieces of the text
const GENERIC_WORDS = new Set(['path', 'road', 'rd', 'lane', 'bylane', 'street', 'near', 'opp', 'opposite',
    'the', 'no', 'house', 'mile', 'six', 'university', 'college', 'school', 'hospital', 'nagar', 'colony', 'chowk', 'chariali', 'guwahati', 'assam']);

function queryVariants(q) {
    const clean = q.replace(/\s+/g, ' ').trim().toLowerCase();
    const list = [clean, clean.replace(/\s*,\s*/g, ' ')];

    // comma pieces, longest (usually most specific) first
    const parts = clean.split(',').map(p => p.trim()).filter(p => p.length >= 3);
    if (parts.length > 1) list.push(...parts.sort((x, y) => y.length - x.length));

    // drop words from the end: "sewali path hatigaon" -> "sewali path" -> "sewali"
    const words = clean.replace(/,/g, ' ').split(' ').filter(Boolean);
    for (let n = words.length - 1; n >= 1; n--) {
        const piece = words.slice(0, n).join(' ');
        if (n > 1 || !GENERIC_WORDS.has(piece)) list.push(piece);
    }
    // last word alone (often the area name): "... hatigaon" -> "hatigaon"
    const last = words[words.length - 1];
    if (words.length > 1 && !GENERIC_WORDS.has(last)) list.push(last);

    return [...new Set(list)].filter(x => x.length >= 3);
}

async function suggestOnce(q) {
    const { minLat, maxLat, minLng, maxLng } = GUWAHATI_BOX;
    let list = [];

    // 1) Photon: made for type-ahead search, handles half-typed words
    try {
        const d = await fetchJSON(`https://photon.komoot.io/api/?limit=8&lat=26.14&lon=91.74` +
            `&bbox=${minLng},${minLat},${maxLng},${maxLat}&q=${encodeURIComponent(q)}`, 6000);
        list = (d.features || []).map(f => {
            const p = f.properties;
            return {
                name: p.name || p.street || q,
                area: uniqueJoin([p.street !== p.name ? p.street : '', p.district || p.locality, p.city || 'Guwahati']),
                lat: f.geometry.coordinates[1],
                lng: f.geometry.coordinates[0]
            };
        });
    } catch (e) {
        console.error('Photon suggest failed:', e.message);
    }

    // 2) Backup: Nominatim inside Guwahati
    if (!list.length) {
        try {
            const box = `${minLng},${maxLat},${maxLng},${minLat}`;
            const d = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=6&viewbox=${box}&bounded=1&q=${encodeURIComponent(q)}`, 6000);
            list = d.map(r => {
                const parts = r.display_name.split(',').map(x => x.trim());
                return { name: parts[0], area: parts.slice(1, 4).join(', '), lat: +r.lat, lng: +r.lon };
            });
        } catch (e) {
            console.error('Nominatim suggest failed:', e.message);
        }
    }
    return list.filter(p => inGuwahati(p.lat, p.lng));
}

app.get('/api/suggest', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const key = q.toLowerCase();
    if (suggestCache[key]) return res.json(suggestCache[key]);

    let list = [];
    for (const v of queryVariants(q)) {
        const found = await suggestOnce(v);
        if (found.length) {
            // if we had to shorten the text, tell the user it's the nearest match
            if (v !== key) found.forEach(p => p.near = true);
            list = found;
            break;
        }
    }

    // remove duplicates with the same name + area
    const seen = new Set();
    list = list.filter(p => { const k = p.name + '|' + p.area; if (seen.has(k)) return false; seen.add(k); return true; });

    if (list.length) suggestCache[key] = list;
    res.json(list);
});

// ---------------- ROUTE API ----------------
// GET /api/route?from=26.12,91.74&to=26.15,91.66  ->  { points, distanceKm, durationMin }
const OSRM_SERVERS = [
    'https://router.project-osrm.org/route/v1/driving/',
    'https://routing.openstreetmap.de/routed-car/route/v1/driving/'
];

app.get('/api/route', async (req, res) => {
    const [fLat, fLng] = String(req.query.from).split(',').map(Number);
    const [tLat, tLng] = String(req.query.to).split(',').map(Number);
    const key = `route:${fLat.toFixed(4)},${fLng.toFixed(4)}->${tLat.toFixed(4)},${tLng.toFixed(4)}`;
    if (cache[key]) return res.json(cache[key]);

    for (const base of OSRM_SERVERS) {
        try {
            const data = await fetchJSON(`${base}${fLng},${fLat};${tLng},${tLat}?overview=full&geometries=geojson`);
            if (data.code !== 'Ok' || !data.routes.length) continue;
            const r = data.routes[0];
            cache[key] = {
                points: r.geometry.coordinates.map(c => [c[1], c[0]]), // [lng,lat] -> [lat,lng]
                distanceKm: r.distance / 1000,
                durationMin: Math.round(r.duration / 60)
            };
            saveCache();
            console.log('Route found via', base);
            return res.json(cache[key]);
        } catch (e) {
            console.error('Routing server failed:', base, e.message);
        }
    }
    res.status(502).json({ error: 'Routing servers not reachable' });
});

// ---------------- CITY FLEET: MANY BUSES + SHUTTLES (real-time via Socket.io) ----------------
// The SERVER runs the whole fleet. Every bus line has fixed stops; several vehicles run on
// each line, going back and forth. Every second the server sends all positions to every browser.
// In a real deployment these positions would come from GPS devices fitted in the vehicles.

// Stop coordinates (approximate) used to build each line's road path
const STOPS = {
    'Jalukbari': [26.1556, 91.6650], 'Adabari': [26.1700, 91.6900], 'Maligaon': [26.1590, 91.6960],
    'Bharalumukh': [26.1760, 91.7240], 'Panbazar': [26.1860, 91.7440], 'Paltan Bazar': [26.1810, 91.7510],
    'Ulubari': [26.1720, 91.7560], 'Bhangagarh': [26.1610, 91.7680], 'Ganeshguri': [26.1490, 91.7800],
    'Dispur': [26.1440, 91.7900], 'Six Mile': [26.1330, 91.8010], 'Khanapara': [26.1230, 91.8170],
    'Chandmari': [26.1830, 91.7790], 'Narengi': [26.1880, 91.8290], 'Zoo Tiniali': [26.1700, 91.7790],
    'Hatigaon': [26.1360, 91.7750], 'Beltola': [26.1250, 91.7900], 'Basistha Chariali': [26.1110, 91.7930],
    'Lokhra': [26.1130, 91.7500], 'ISBT': [26.1139, 91.7245]
};

// Lines: every line has BOTH city buses and electric shuttles running on it
const LINES = [
    { id: '1', buses: 4, shuttles: 3, stops: ['Jalukbari', 'Maligaon', 'Paltan Bazar', 'Ganeshguri', 'Six Mile', 'Khanapara'] },
    { id: '2', buses: 4, shuttles: 3, stops: ['ISBT', 'Lokhra', 'Ulubari', 'Panbazar'] },
    { id: '3', buses: 4, shuttles: 3, stops: ['Adabari', 'Bharalumukh', 'Panbazar', 'Chandmari', 'Narengi'] },
    { id: '4', buses: 4, shuttles: 3, stops: ['Jalukbari', 'ISBT', 'Lokhra', 'Basistha Chariali'] },
    { id: '5', buses: 4, shuttles: 3, stops: ['ISBT', 'Lokhra', 'Basistha Chariali', 'Beltola', 'Hatigaon', 'Ganeshguri', 'Zoo Tiniali', 'Chandmari'] },
    { id: '6', buses: 4, shuttles: 3, stops: ['ISBT', 'Lokhra', 'Basistha Chariali', 'Hatigaon'] },
    { id: '7', buses: 4, shuttles: 3, stops: ['Paltan Bazar', 'Ulubari', 'Bhangagarh', 'Ganeshguri', 'Dispur'] },
    { id: '8', buses: 4, shuttles: 3, stops: ['Jalukbari', 'Maligaon', 'Bharalumukh', 'Panbazar'] }
];

const SPEED_KMH = { bus: 18, shuttle: 22 };  // real average city speed incl. stops (used for ETA)
const DEMO_SPEEDUP = 12;                     // on screen vehicles move 12x faster so the demo looks alive
const TICK_MS = 1000;

const fleet = { lines: [], vehicles: [], ready: false };

function haversine(a, b) {   // distance in metres between [lat,lng] points
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Road path through all stops of a line (OSRM supports many points in one request), cached in the file
async function lineRoadPath(stopNames) {
    const pts = stopNames.map(n => STOPS[n]);
    const key = 'line:' + stopNames.join('>');
    if (cache[key]) return cache[key];
    const coords = pts.map(p => `${p[1]},${p[0]}`).join(';');
    for (const base of OSRM_SERVERS) {
        try {
            const data = await fetchJSON(`${base}${coords}?overview=full&geometries=geojson`, 15000);
            if (data.code !== 'Ok' || !data.routes.length) continue;
            cache[key] = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
            saveCache();
            return cache[key];
        } catch (e) {
            console.error('Line route failed:', base, e.message);
        }
    }
    console.warn('Using straight lines for', stopNames.join(' > '), '(routing server not reachable)');
    return pts;   // fallback: stop-to-stop straight lines (not cached, so next start tries again)
}

async function buildFleet() {
    for (const line of LINES) {
        const points = await lineRoadPath(line.stops);
        const cumDist = [0];
        for (let i = 1; i < points.length; i++) cumDist.push(cumDist[i - 1] + haversine(points[i - 1], points[i]));
        const totalM = cumDist[cumDist.length - 1];
        const name = `${line.stops[0]} ⇄ ${line.stops[line.stops.length - 1]}`;
        fleet.lines.push({ id: line.id, name, stops: line.stops, points, cumDist, totalM });

        // spread buses and shuttles evenly over the round trip (there and back = 2 x length)
        const types = [];
        for (let k = 0; k < Math.max(line.buses, line.shuttles); k++) {
            if (k < line.buses) types.push('bus');
            if (k < line.shuttles) types.push('shuttle');
        }
        const count = { bus: 0, shuttle: 0 };
        types.forEach((type, k) => {
            count[type]++;
            fleet.vehicles.push({
                id: `${line.id}-${type === 'bus' ? 'B' : 'S'}${count[type]}`,   // e.g. "5-S2" = 2nd shuttle on route 5
                lineId: line.id,
                type,
                s: (2 * totalM) * k / types.length,    // position on the round trip in metres
                total: totalM
            });
        });
    }
    fleet.ready = true;
    console.log(`Fleet ready: ${fleet.vehicles.length} vehicles on ${fleet.lines.length} lines`);
    io.emit('fleetInit', fleetInitData());
}

function fleetInitData() {
    return {
        lines: fleet.lines.map(l => ({ id: l.id, name: l.name, points: l.points, cumDist: l.cumDist, totalM: l.totalM,
            stops: l.stops.map(n => ({ name: n, coord: STOPS[n] })) })),   // bus stops of the line
        speedKmh: SPEED_KMH
    };
}

io.on('connection', (socket) => {
    if (fleet.ready) socket.emit('fleetInit', fleetInitData());
});

// Move every vehicle a little each second and send everyone the new positions
setInterval(() => {
    if (!fleet.ready) return;
    const update = [];
    for (const v of fleet.vehicles) {
        const metresPerTick = SPEED_KMH[v.type] / 3.6 * DEMO_SPEEDUP * (TICK_MS / 1000);
        v.s = (v.s + metresPerTick) % (2 * v.total);           // back to start after a full round trip
        update.push({ id: v.id, lineId: v.lineId, type: v.type, s: Math.round(v.s) });
    }
    io.emit('fleetUpdate', { time: Date.now(), vehicles: update });
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`TransitGo server running on http://localhost:${PORT}`);
    buildFleet();   // fetch road paths for all bus lines, then start the fleet
});