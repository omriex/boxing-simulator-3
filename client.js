document.addEventListener('contextmenu', event => event.preventDefault());

const ws = new WebSocket('wss://faster-conjoined-angling.ngrok-free.dev');

let myId = null;
let serverPlayers = {};
let serverItems = [];
let localInventory = ['glove', null, null, null, null];
let localInventorySelected = 0;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

const WORLD = {
    MAP: { chunkSize: 1024, tilesetCols: 0, layers: [], bgChunks: [], fgChunks: [] },
    CAMERA: { x: null, y: null, width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT },
    INPUTS: {
        keys: { w: false, a: false, s: false, d: false, shift: false },
        mouseX: 0, mouseY: 0, isMouseDown: false
    },
    EDITOR: { enabled: false, selectedTileGid: 1, selectedLayer: "background" },
    SYSTEM: { viewScale: 1, assetsLoaded: 0, isReady: false },
    NEAREST_ITEM: null
};

const tilesheetImg = new Image();
const playerImg = new Image();
const gloveImg = new Image();

let dragIndex = -1;
const dragGhost = document.createElement('div');
dragGhost.id = 'drag-ghost';
document.body.appendChild(dragGhost);

let lastRenderTime = performance.now();

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'init') {
        myId = data.id;
        WORLD.MAP.tileSize = data.map.tileSize;
        WORLD.MAP.columns = data.map.columns;
        WORLD.MAP.rows = data.map.rows;
        WORLD.MAP.layers = data.map.layers;
        document.getElementById('loading-text').innerText = "LOADING ASSETS...";
        loadImages();
    } 
    else if (data.type === 'state') {
        const newPlayers = {};
        for (let id in data.players) {
            if (serverPlayers[id]) {
                Object.assign(serverPlayers[id], data.players[id]);
                newPlayers[id] = serverPlayers[id];
            } else {
                newPlayers[id] = data.players[id];
            }
        }
        serverPlayers = newPlayers;

        const newItems = [];
        for (let i = 0; i < data.items.length; i++) {
            const incoming = data.items[i];
            const existing = serverItems.find(item => item.id === incoming.id);
            if (existing) {
                Object.assign(existing, incoming);
                newItems.push(existing);
            } else {
                newItems.push(incoming);
            }
        }
        serverItems = newItems;

        if (serverPlayers[myId]) {
            localInventory = serverPlayers[myId].inventory;
            localInventorySelected = serverPlayers[myId].inventorySelected;
            renderInventory();
            updateLeaderboard();
        }
    } 
    else if (data.type === 'map_update') {
        const layer = WORLD.MAP.layers.find(l => l.name === data.layer);
        if (layer) {
            layer.data[data.row * WORLD.MAP.columns + data.col] = data.gid;
            const cx = Math.floor((data.col * WORLD.MAP.tileSize) / WORLD.MAP.chunkSize);
            const cy = Math.floor((data.row * WORLD.MAP.tileSize) / WORLD.MAP.chunkSize);
            renderChunk(cx, cy);
        }
    }
};

function sendInput() {
    if (!myId || !serverPlayers[myId]) return;
    const scaledMouseX = WORLD.INPUTS.mouseX / WORLD.SYSTEM.viewScale;
    const scaledMouseY = WORLD.INPUTS.mouseY / WORLD.SYSTEM.viewScale;
    const myP = serverPlayers[myId];
    
    const px = myP.renderX !== undefined ? myP.renderX : myP.x;
    const py = myP.renderY !== undefined ? myP.renderY : myP.y;

    const playerScreenX = px - WORLD.CAMERA.x + (myP.width / 2);
    const playerScreenY = py - WORLD.CAMERA.y + (myP.height / 2);
    const angle = Math.atan2(scaledMouseY - playerScreenY, scaledMouseX - playerScreenX) + (Math.PI / 2);

    ws.send(JSON.stringify({
        type: 'input',
        keys: WORLD.INPUTS.keys,
        isMouseDown: WORLD.INPUTS.isMouseDown,
        angle: angle
    }));
}

function sendGloveSettings() {
    ws.send(JSON.stringify({
        type: 'glove_settings',
        offsetX: parseFloat(document.getElementById('gOffsetX').value) || 0,
        offsetY: parseFloat(document.getElementById('gOffsetY').value) || 0,
        width: parseFloat(document.getElementById('gWidth').value) || 0,
        height: parseFloat(document.getElementById('gHeight').value) || 0,
        rotation: parseFloat(document.getElementById('gRotation').value) || 0,
        animType: document.getElementById('gAnimType').value,
        animSpeed: parseFloat(document.getElementById('gSpeed').value) || 1
    }));
}

document.getElementById('editor-toggle-btn').addEventListener('click', function() {
    WORLD.EDITOR.enabled = !WORLD.EDITOR.enabled;
    const tools = document.getElementById('editor-tools');
    if (WORLD.EDITOR.enabled) {
        this.innerText = "Editor: ON";
        this.classList.add('active');
        tools.style.display = 'flex';
    } else {
        this.innerText = "Editor: OFF";
        this.classList.remove('active');
        tools.style.display = 'none';
    }
});

document.querySelectorAll('#editor-ui .layer-btn').forEach(btn => {
    if (btn.id === 'editor-toggle-btn') return;
    btn.addEventListener('click', () => {
        document.querySelectorAll('#layer-toggles .layer-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        WORLD.EDITOR.selectedLayer = btn.dataset.layer;
    });
});

['gOffsetX', 'gOffsetY', 'gWidth', 'gHeight', 'gRotationSlider', 'gRotation', 'gSpeedSlider', 'gSpeed', 'gAnimType'].forEach(id => {
    document.getElementById(id).addEventListener('input', (e) => {
        if(id === 'gRotationSlider') document.getElementById('gRotation').value = e.target.value;
        if(id === 'gRotation') document.getElementById('gRotationSlider').value = e.target.value;
        if(id === 'gSpeedSlider') document.getElementById('gSpeed').value = e.target.value;
        if(id === 'gSpeed') document.getElementById('gSpeedSlider').value = e.target.value;
        sendGloveSettings();
    });
});

document.getElementById('leaderboard-header').addEventListener('click', () => {
    const list = document.getElementById('leaderboard-list');
    const toggle = document.getElementById('leaderboard-toggle');
    if (list.style.display === 'none') {
        list.style.display = 'flex';
        toggle.style.transform = 'rotate(0deg)';
    } else {
        list.style.display = 'none';
        toggle.style.transform = 'rotate(180deg)';
    }
});

function preventZoom(e) {
    if (e.ctrlKey || e.metaKey) {
        if (e.type === 'wheel' || ['=', '-', '0', '+'].includes(e.key) || ['NumpadAdd', 'NumpadSubtract'].includes(e.code)) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }
}
window.addEventListener('wheel', preventZoom, { passive: false });
window.addEventListener('keydown', preventZoom, { passive: false });
window.addEventListener('resize', resizeCanvas);

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    WORLD.SYSTEM.viewScale = Math.max(canvas.width / LOGICAL_WIDTH, canvas.height / LOGICAL_HEIGHT);
    WORLD.CAMERA.width = canvas.width / WORLD.SYSTEM.viewScale;
    WORLD.CAMERA.height = canvas.height / WORLD.SYSTEM.viewScale;
    ctx.imageSmoothingEnabled = false;
}

window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    const mapKeys = {'arrowup':'w', 'arrowdown':'s', 'arrowleft':'a', 'arrowright':'d'};
    const mapped = mapKeys[key] || key;

    if (WORLD.INPUTS.keys.hasOwnProperty(mapped)) { WORLD.INPUTS.keys[mapped] = true; sendInput(); }
    
    if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
        if (['1','2','3','4','5'].includes(key)) {
            ws.send(JSON.stringify({ type: 'inv_select', index: parseInt(key) - 1 }));
        } else if (key === 'g') {
            ws.send(JSON.stringify({ type: 'drop', index: localInventorySelected }));
        } else if (key === 'e') {
            if (WORLD.NEAREST_ITEM && localInventory.includes(null)) {
                ws.send(JSON.stringify({ type: 'pickup', itemId: WORLD.NEAREST_ITEM.id }));
            }
        }
    }
});

window.addEventListener('keyup', e => {
    const key = e.key.toLowerCase();
    const mapKeys = {'arrowup':'w', 'arrowdown':'s', 'arrowleft':'a', 'arrowright':'d'};
    const mapped = mapKeys[key] || key;
    if (WORLD.INPUTS.keys.hasOwnProperty(mapped)) { WORLD.INPUTS.keys[mapped] = false; sendInput(); }
});

window.addEventListener('mousemove', e => { 
    WORLD.INPUTS.mouseX = e.clientX; 
    WORLD.INPUTS.mouseY = e.clientY; 
    if (WORLD.INPUTS.isMouseDown && dragIndex === -1 && WORLD.EDITOR.enabled) handleMapEdit(WORLD.INPUTS.mouseX, WORLD.INPUTS.mouseY);
    if (dragIndex !== -1) {
        dragGhost.style.left = (e.clientX - 32) + 'px';
        dragGhost.style.top = (e.clientY - 32) + 'px';
    }
    sendInput();
});

window.addEventListener('mousedown', e => {
    if (e.button === 2) { 
        if(WORLD.NEAREST_ITEM && localInventory.includes(null)) {
            ws.send(JSON.stringify({ type: 'pickup', itemId: WORLD.NEAREST_ITEM.id }));
        }
        return;
    }
    if (e.target.closest('#editor-ui') || e.target.closest('#leaderboard-ui') || e.target.closest('#inventory-ui')) return;
    
    if (e.button === 0) {
        WORLD.INPUTS.isMouseDown = true;
        sendInput();
        if (WORLD.EDITOR.enabled) handleMapEdit(e.clientX, e.clientY);
    }
});

window.addEventListener('mouseup', e => {
    WORLD.INPUTS.isMouseDown = false;
    sendInput();
    
    if (dragIndex !== -1) {
        dragGhost.style.display = 'none';
        const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
        if (dropTarget && dropTarget.classList.contains('inv-slot')) {
            const dropIndex = Array.from(document.querySelectorAll('.inv-slot')).indexOf(dropTarget);
            ws.send(JSON.stringify({ type: 'inv_swap', from: dragIndex, to: dropIndex }));
        } else if (!e.target.closest('#inventory-ui')) {
            ws.send(JSON.stringify({ type: 'drop', index: dragIndex }));
        }
        dragIndex = -1;
    }
});

function handleMapEdit(screenX, screenY) {
    const worldX = (screenX / WORLD.SYSTEM.viewScale) + WORLD.CAMERA.x;
    const worldY = (screenY / WORLD.SYSTEM.viewScale) + WORLD.CAMERA.y;
    const col = Math.floor(worldX / WORLD.MAP.tileSize);
    const row = Math.floor(worldY / WORLD.MAP.tileSize);
    if (col >= 0 && col < WORLD.MAP.columns && row >= 0 && row < WORLD.MAP.rows) {
        ws.send(JSON.stringify({ type: 'edit', layer: WORLD.EDITOR.selectedLayer, col, row, gid: WORLD.EDITOR.selectedTileGid }));
    }
}

function updateLeaderboard() {
    const lbList = document.getElementById('leaderboard-list');
    lbList.innerHTML = '';
    Object.values(serverPlayers).forEach(p => {
        const div = document.createElement('div');
        div.className = 'leaderboard-entry';
        div.innerHTML = `<span>${p.name}</span>`;
        lbList.appendChild(div);
    });
}

function renderInventory() {
    document.querySelectorAll('.inv-slot').forEach((slot, i) => {
        slot.className = 'inv-slot' + (localInventorySelected === i ? ' selected' : '');
        if (localInventory[i] === 'glove') {
            slot.style.backgroundImage = `url(${gloveImg.src})`;
            slot.style.backgroundSize = '70%';
            slot.style.backgroundPosition = 'center';
            slot.style.backgroundRepeat = 'no-repeat';
        } else {
            slot.style.backgroundImage = 'none';
        }

        slot.onmouseenter = (e) => {
            if (dragIndex !== -1 || !localInventory[i]) return;
            const tooltip = document.getElementById('tooltip-ui');
            document.getElementById('tooltip-header').innerText = localInventory[i].charAt(0).toUpperCase() + localInventory[i].slice(1);
            tooltip.style.display = 'flex';
            const rect = slot.getBoundingClientRect();
            tooltip.style.left = (rect.left + rect.width / 2) + 'px';
            tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
        };

        slot.onmouseleave = () => document.getElementById('tooltip-ui').style.display = 'none';

        slot.onmousedown = (e) => {
            ws.send(JSON.stringify({ type: 'inv_select', index: i }));
            if (localInventory[i]) {
                document.getElementById('tooltip-ui').style.display = 'none';
                dragIndex = i;
                dragGhost.style.backgroundImage = slot.style.backgroundImage;
                dragGhost.style.display = 'block';
                dragGhost.style.left = (e.clientX - 32) + 'px';
                dragGhost.style.top = (e.clientY - 32) + 'px';
                slot.style.backgroundImage = 'none';
            }
        };
    });
}

function loadImages() {
    tilesheetImg.crossOrigin = "Anonymous";
    tilesheetImg.onload = () => {
        WORLD.MAP.tilesetCols = Math.floor(tilesheetImg.width / WORLD.MAP.tileSize);
        initEditorUI();
        onAssetLoad();
    };
    tilesheetImg.src = "assets/tilesheet.png";

    playerImg.crossOrigin = "Anonymous";
    playerImg.onload = onAssetLoad;
    playerImg.src = "assets/player.webp";

    gloveImg.crossOrigin = "Anonymous";
    gloveImg.onload = onAssetLoad;
    gloveImg.src = "assets/glove.png";
}

function onAssetLoad() {
    WORLD.SYSTEM.assetsLoaded++;
    if (WORLD.SYSTEM.assetsLoaded === 3) {
        preRenderMap();
        document.getElementById('loading-screen').style.display = 'none';
        resizeCanvas();
        WORLD.SYSTEM.isReady = true;
        sendGloveSettings();
        requestAnimationFrame(render);
    }
}

function preRenderMap() {
    const numChunksX = Math.ceil((WORLD.MAP.columns * WORLD.MAP.tileSize) / WORLD.MAP.chunkSize);
    const numChunksY = Math.ceil((WORLD.MAP.rows * WORLD.MAP.tileSize) / WORLD.MAP.chunkSize);
    
    WORLD.MAP.bgChunks = [];
    WORLD.MAP.fgChunks = [];
    for (let cy = 0; cy < numChunksY; cy++) {
        WORLD.MAP.bgChunks[cy] = [];
        WORLD.MAP.fgChunks[cy] = [];
        for (let cx = 0; cx < numChunksX; cx++) {
            WORLD.MAP.bgChunks[cy][cx] = document.createElement('canvas');
            WORLD.MAP.bgChunks[cy][cx].width = WORLD.MAP.chunkSize; 
            WORLD.MAP.bgChunks[cy][cx].height = WORLD.MAP.chunkSize;
            WORLD.MAP.fgChunks[cy][cx] = document.createElement('canvas');
            WORLD.MAP.fgChunks[cy][cx].width = WORLD.MAP.chunkSize; 
            WORLD.MAP.fgChunks[cy][cx].height = WORLD.MAP.chunkSize;
            renderChunk(cx, cy);
        }
    }
}

function renderChunk(cx, cy) {
    const bgCtx = WORLD.MAP.bgChunks[cy][cx].getContext('2d', { alpha: true });
    const fgCtx = WORLD.MAP.fgChunks[cy][cx].getContext('2d', { alpha: true });
    
    bgCtx.imageSmoothingEnabled = false; fgCtx.imageSmoothingEnabled = false;
    bgCtx.clearRect(0, 0, WORLD.MAP.chunkSize, WORLD.MAP.chunkSize);
    fgCtx.clearRect(0, 0, WORLD.MAP.chunkSize, WORLD.MAP.chunkSize);

    const startCol = Math.floor((cx * WORLD.MAP.chunkSize) / WORLD.MAP.tileSize);
    const endCol = Math.ceil(((cx + 1) * WORLD.MAP.chunkSize) / WORLD.MAP.tileSize);
    const startRow = Math.floor((cy * WORLD.MAP.chunkSize) / WORLD.MAP.tileSize);
    const endRow = Math.ceil(((cy + 1) * WORLD.MAP.chunkSize) / WORLD.MAP.tileSize);

    WORLD.MAP.layers.forEach(layer => {
        const targetCtx = (layer.name === "trees") ? fgCtx : bgCtx;
        for (let r = Math.max(0, startRow); r < Math.min(WORLD.MAP.rows, endRow); r++) {
            for (let c = Math.max(0, startCol); c < Math.min(WORLD.MAP.columns, endCol); c++) {
                const gid = layer.data[r * WORLD.MAP.columns + c];
                if (gid > 0) {
                    const tId = gid - 1;
                    targetCtx.drawImage(
                        tilesheetImg,
                        (tId % WORLD.MAP.tilesetCols) * WORLD.MAP.tileSize, 
                        Math.floor(tId / WORLD.MAP.tilesetCols) * WORLD.MAP.tileSize, 
                        WORLD.MAP.tileSize, WORLD.MAP.tileSize,
                        (c * WORLD.MAP.tileSize) - (cx * WORLD.MAP.chunkSize), 
                        (r * WORLD.MAP.tileSize) - (cy * WORLD.MAP.chunkSize), 
                        WORLD.MAP.tileSize + 0.5, WORLD.MAP.tileSize + 0.5
                    );
                }
            }
        }
    });
}

function render() {
    requestAnimationFrame(render);
    if (!WORLD.SYSTEM.isReady || !serverPlayers[myId]) return;
    
    const now = performance.now();
    let dt = (now - lastRenderTime) / 1000;
    if (dt > 0.1) dt = 0.1;
    lastRenderTime = now;

    const myP = serverPlayers[myId];

    if (myP.cx === undefined) {
        myP.cx = myP.x;
        myP.cy = myP.y;
        myP.cvx = myP.vx;
        myP.cvy = myP.vy;
    }

    let inputX = 0, inputY = 0;
    if (WORLD.INPUTS.keys.w) inputY -= 1;
    if (WORLD.INPUTS.keys.s) inputY += 1;
    if (WORLD.INPUTS.keys.a) inputX -= 1;
    if (WORLD.INPUTS.keys.d) inputX += 1;

    if (inputX !== 0 || inputY !== 0) {
        const length = Math.sqrt(inputX * inputX + inputY * inputY);
        inputX /= length;
        inputY /= length;
    }

    let intentSprint = WORLD.INPUTS.keys.shift && (inputX !== 0 || inputY !== 0);
    let accel = intentSprint ? 1866 : 1493;
    const friction = Math.pow(0.001, dt);

    myP.cvx += inputX * accel * dt;
    myP.cvy += inputY * accel * dt;
    myP.cvx *= friction;
    myP.cvy *= friction;
    myP.cx += myP.cvx * dt;
    myP.cy += myP.cvy * dt;

    for (let i = 0; i < 3; i++) {
        const scale = myP.scale || 1;
        const radius = (myP.width * scale) / 2;
        let pX = myP.cx + (myP.width / 2);
        let pY = myP.cy + (myP.height / 2);
        
        const wallLayer = WORLD.MAP.layers.find(l => l.name === "walls");
        if (wallLayer) {
            const left = Math.floor((pX - radius) / WORLD.MAP.tileSize);
            const right = Math.floor((pX + radius) / WORLD.MAP.tileSize);
            const top = Math.floor((pY - radius) / WORLD.MAP.tileSize);
            const bottom = Math.floor((pY + radius) / WORLD.MAP.tileSize);
            
            for (let r = top; r <= bottom; r++) {
                for (let c = left; c <= right; c++) {
                    if (c < 0 || c >= WORLD.MAP.columns || r < 0 || r >= WORLD.MAP.rows) continue;
                    const index = r * WORLD.MAP.columns + c;
                    if (wallLayer.data[index] > 0) {
                        const tileX = c * WORLD.MAP.tileSize;
                        const tileY = r * WORLD.MAP.tileSize;
                        let testX = pX;
                        let testY = pY;
                        
                        if (pX < tileX) testX = tileX;
                        else if (pX > tileX + WORLD.MAP.tileSize) testX = tileX + WORLD.MAP.tileSize;
                        
                        if (pY < tileY) testY = tileY;
                        else if (pY > tileY + WORLD.MAP.tileSize) testY = tileY + WORLD.MAP.tileSize;
                        
                        const distX = pX - testX;
                        const distY = pY - testY;
                        const distance = Math.sqrt(distX * distX + distY * distY);
                        
                        if (distance > 0 && distance < radius) {
                            const overlap = radius - distance;
                            const nx = distX / distance;
                            const ny = distY / distance;
                            pX += nx * overlap;
                            pY += ny * overlap;
                        }
                    }
                }
            }
        }
        myP.cx = pX - (myP.width / 2);
        myP.cy = pY - (myP.height / 2);
    }

    if (myP.cx < 0) myP.cx = 0;
    if (myP.cy < 0) myP.cy = 0;
    if (myP.cx + myP.width > WORLD.MAP.columns * WORLD.MAP.tileSize) myP.cx = WORLD.MAP.columns * WORLD.MAP.tileSize - myP.width;
    if (myP.cy + myP.height > WORLD.MAP.rows * WORLD.MAP.tileSize) myP.cy = WORLD.MAP.rows * WORLD.MAP.tileSize - myP.height;

    const distSq = Math.pow(myP.x - myP.cx, 2) + Math.pow(myP.y - myP.cy, 2);
    if (distSq > 10000) {
        myP.cx = myP.x;
        myP.cy = myP.y;
    } else {
        myP.cx += (myP.x - myP.cx) * 0.1;
        myP.cy += (myP.y - myP.cy) * 0.1;
    }

    myP.renderX = myP.cx;
    myP.renderY = myP.cy;

    const scaledMouseX = WORLD.INPUTS.mouseX / WORLD.SYSTEM.viewScale;
    const scaledMouseY = WORLD.INPUTS.mouseY / WORLD.SYSTEM.viewScale;
    const playerScreenX = myP.renderX - WORLD.CAMERA.x + (myP.width / 2);
    const playerScreenY = myP.renderY - WORLD.CAMERA.y + (myP.height / 2);
    myP.angle = Math.atan2(scaledMouseY - playerScreenY, scaledMouseX - playerScreenX) + (Math.PI / 2);
    myP.renderAngle = myP.angle;

    Object.values(serverPlayers).forEach(p => {
        if (p.id !== myId) {
            if (p.renderX === undefined) {
                p.renderX = p.x;
                p.renderY = p.y;
                p.renderAngle = p.angle;
            } else {
                p.renderX += (p.x - p.renderX) * 0.3;
                p.renderY += (p.y - p.renderY) * 0.3;
                let diff = p.angle - p.renderAngle;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                p.renderAngle += diff * 0.3;
            }
        }
    });

    serverItems.forEach(item => {
        if (item.renderX === undefined) {
            item.renderX = item.x;
            item.renderY = item.y;
        } else {
            item.renderX += (item.x - item.renderX) * 0.3;
            item.renderY += (item.y - item.renderY) * 0.3;
        }
    });

    let nearestDist = Infinity;
    WORLD.NEAREST_ITEM = null;
    const px = myP.renderX + myP.width / 2;
    const py = myP.renderY + myP.height / 2;
    serverItems.forEach(item => {
        let dist = Math.sqrt(Math.pow(item.renderX - px, 2) + Math.pow(item.renderY - py, 2));
        if (dist < 70 && dist < nearestDist && item.animState !== 'picking_up') {
            nearestDist = dist;
            WORLD.NEAREST_ITEM = item;
        }
    });

    const targetCamX = myP.renderX + (myP.width / 2) - (WORLD.CAMERA.width / 2);
    const targetCamY = myP.renderY + (myP.height / 2) - (WORLD.CAMERA.height / 2);
    if (WORLD.CAMERA.x === null) {
        WORLD.CAMERA.x = targetCamX; 
        WORLD.CAMERA.y = targetCamY;
    } else {
        WORLD.CAMERA.x += (targetCamX - WORLD.CAMERA.x) * 0.15;
        WORLD.CAMERA.y += (targetCamY - WORLD.CAMERA.y) * 0.15;
    }

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(WORLD.SYSTEM.viewScale, WORLD.SYSTEM.viewScale);

    const camX = Math.round(WORLD.CAMERA.x);
    const camY = Math.round(WORLD.CAMERA.y);

    const startCX = Math.max(0, Math.floor(camX / WORLD.MAP.chunkSize));
    const endCX = Math.min(WORLD.MAP.bgChunks[0].length - 1, Math.floor((camX + WORLD.CAMERA.width) / WORLD.MAP.chunkSize));
    const startCY = Math.max(0, Math.floor(camY / WORLD.MAP.chunkSize));
    const endCY = Math.min(WORLD.MAP.bgChunks.length - 1, Math.floor((camY + WORLD.CAMERA.height) / WORLD.MAP.chunkSize));

    for (let cy = startCY; cy <= endCY; cy++) {
        for (let cx = startCX; cx <= endCX; cx++) {
            ctx.drawImage(WORLD.MAP.bgChunks[cy][cx], cx * WORLD.MAP.chunkSize - camX, cy * WORLD.MAP.chunkSize - camY, WORLD.MAP.chunkSize + 0.5, WORLD.MAP.chunkSize + 0.5);
        }
    }

    serverItems.forEach(item => {
        ctx.save();
        ctx.translate(item.renderX - camX, item.renderY - camY);
        let scale = 0.95;
        let rot = item.targetRotation;
        
        if (item.animState === 'dropping') {
            let t = Math.max(0, Math.min(1, 1 - (item.animTimer / 0.3)));
            let ease = 1 - Math.pow(1 - t, 3);
            scale = 0.95 * ease;
            rot = item.targetRotation * ease + ((serverPlayers[item.pickerId || myId]?.renderAngle || 0)) * (1 - ease);
        } else if (item.animState === 'picking_up') {
            let t = Math.max(0, Math.min(1, item.animTimer / 0.2)); 
            scale = 0.95 * t;
            rot = item.targetRotation * t + ((serverPlayers[item.pickerId]?.renderAngle || 0)) * (1 - t);
        }
        
        ctx.rotate(rot);
        ctx.scale(scale, scale);
        if (item.type === 'glove') {
            ctx.drawImage(gloveImg, -11, -14.5, 22, 29);
        }
        ctx.restore();
    });

    Object.values(serverPlayers).forEach(p => {
        const pRenderX = p.renderX - camX + (p.width / 2);
        const pRenderY = p.renderY - camY + (p.height / 2);
        const pScaledW = p.width * (p.scale || 1);
        const pScaledH = p.height * (p.scale || 1);

        if (p.inventory[p.inventorySelected] === 'glove') {
            ctx.save();
            ctx.translate(pRenderX, pRenderY);
            ctx.rotate(p.renderAngle);
            ctx.translate(p.renderState.equipOffsetX, p.renderState.equipOffsetY);
            ctx.rotate((p.renderState.equipRot * Math.PI / 180) + p.renderState.animRotation);
            ctx.translate(0, -p.renderState.animPokeOffset);
            ctx.drawImage(gloveImg, -p.glove.width / 2, -p.glove.height / 2, p.glove.width, p.glove.height);
            ctx.restore();
        }

        ctx.save();
        ctx.translate(pRenderX, pRenderY);
        ctx.rotate(p.renderAngle);
        ctx.drawImage(playerImg, -pScaledW / 2, -pScaledH / 2, pScaledW, pScaledH);
        ctx.restore();

        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
        ctx.font = "bold 13px 'Segoe UI'";
        ctx.fillStyle = "#ffffff";
        
        ctx.strokeText(p.name, pRenderX, pRenderY - (pScaledH / 2) - 16);
        ctx.fillText(p.name, pRenderX, pRenderY - (pScaledH / 2) - 16);
    });

    if (WORLD.NEAREST_ITEM && localInventory.includes(null)) {
        ctx.save();
        ctx.translate(WORLD.NEAREST_ITEM.renderX - camX, WORLD.NEAREST_ITEM.renderY - camY - 25);
        ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
        ctx.fillRect(-12, -12, 24, 24);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 13px 'Segoe UI'";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("E", 0, 1);
        ctx.restore();
    }

    for (let cy = startCY; cy <= endCY; cy++) {
        for (let cx = startCX; cx <= endCX; cx++) {
            ctx.drawImage(WORLD.MAP.fgChunks[cy][cx], cx * WORLD.MAP.chunkSize - camX, cy * WORLD.MAP.chunkSize - camY, WORLD.MAP.chunkSize + 0.5, WORLD.MAP.chunkSize + 0.5);
        }
    }

    if (WORLD.EDITOR.enabled && WORLD.EDITOR.selectedTileGid >= 0) {
        const worldX = (WORLD.INPUTS.mouseX / WORLD.SYSTEM.viewScale) + WORLD.CAMERA.x;
        const worldY = (WORLD.INPUTS.mouseY / WORLD.SYSTEM.viewScale) + WORLD.CAMERA.y;
        const col = Math.floor(worldX / WORLD.MAP.tileSize);
        const row = Math.floor(worldY / WORLD.MAP.tileSize);
        
        if (col >= 0 && col < WORLD.MAP.columns && row >= 0 && row < WORLD.MAP.rows) {
            const drawX = col * WORLD.MAP.tileSize - camX;
            const drawY = row * WORLD.MAP.tileSize - camY;
            if (WORLD.EDITOR.selectedTileGid > 0) {
                const tileId = WORLD.EDITOR.selectedTileGid - 1;
                ctx.save(); ctx.globalAlpha = 0.5;
                ctx.drawImage(
                    tilesheetImg, 
                    (tileId % WORLD.MAP.tilesetCols) * WORLD.MAP.tileSize, 
                    Math.floor(tileId / WORLD.MAP.tilesetCols) * WORLD.MAP.tileSize, 
                    WORLD.MAP.tileSize, WORLD.MAP.tileSize, 
                    drawX, drawY, WORLD.MAP.tileSize, WORLD.MAP.tileSize
                );
                ctx.restore();
            } else {
                ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = "rgba(0, 0, 0, 0.5)"; ctx.fillRect(drawX, drawY, WORLD.MAP.tileSize, WORLD.MAP.tileSize); ctx.restore();
            }
        }
    }
    ctx.restore();
}

function initEditorUI() {
    const palette = document.getElementById('palette');
    const desiredTiles = [{ name: "Grass", col: 0, row: 0 }, { name: "Dirt",  col: 1, row: 0 }, { name: "Stone", col: 0, row: 1 }];

    desiredTiles.forEach((tile, index) => {
        const btn = document.createElement('div');
        btn.className = 'tile-btn' + (index === 0 ? ' selected' : '');
        btn.style.backgroundImage = `url(${tilesheetImg.src})`;
        btn.style.backgroundSize = '512px 512px'; 
        btn.style.backgroundPosition = `-${tile.col * WORLD.MAP.tileSize}px -${tile.row * WORLD.MAP.tileSize}px`;
        
        btn.onclick = () => {
            document.querySelectorAll('.tile-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            WORLD.EDITOR.selectedTileGid = (tile.row * WORLD.MAP.tilesetCols) + tile.col + 1; 
        };
        palette.appendChild(btn);
    });

    const eraser = document.createElement('div');
    eraser.className = 'tile-btn eraser-btn';
    eraser.onclick = () => {
        document.querySelectorAll('.tile-btn').forEach(b => b.classList.remove('selected'));
        eraser.classList.add('selected');
        WORLD.EDITOR.selectedTileGid = 0;
    };
    palette.appendChild(eraser);
}
