const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`Server started on port ${PORT}`);

const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;
const MAP = {
    tileSize: 64,
    columns: 60,
    rows: 60,
    layers: [
        { name: "background", data: new Array(60 * 60).fill(1) },
        { name: "floor2",     data: new Array(60 * 60).fill(0) },
        { name: "walls",      data: new Array(60 * 60).fill(0) },
        { name: "trees",      data: new Array(60 * 60).fill(0) }
    ]
};

const players = {};
let droppedItems = [];
let itemIdCounter = 0;
let playerIdCounter = 0;

let lastTime = Date.now();

function resolveCircleCollisions(p) {
    const scale = p.scale;
    const radius = (p.width * scale) / 2;
    let pX = p.x + (p.width / 2);
    let pY = p.y + (p.height / 2);
    
    const left = Math.floor((pX - radius) / MAP.tileSize);
    const right = Math.floor((pX + radius) / MAP.tileSize);
    const top = Math.floor((pY - radius) / MAP.tileSize);
    const bottom = Math.floor((pY + radius) / MAP.tileSize);
    
    const wallLayer = MAP.layers.find(l => l.name === "walls");
    if (!wallLayer) return;
    
    for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
            if (c < 0 || c >= MAP.columns || r < 0 || r >= MAP.rows) continue;
            const index = r * MAP.columns + c;
            if (wallLayer.data[index] > 0) {
                const tileX = c * MAP.tileSize;
                const tileY = r * MAP.tileSize;
                let testX = pX;
                let testY = pY;
                
                if (pX < tileX) testX = tileX;
                else if (pX > tileX + MAP.tileSize) testX = tileX + MAP.tileSize;
                
                if (pY < tileY) testY = tileY;
                else if (pY > tileY + MAP.tileSize) testY = tileY + MAP.tileSize;
                
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
    p.x = pX - (p.width / 2);
    p.y = pY - (p.height / 2);
}

function spawnDroppedItem(type, p) {
    const dropSpeed = 800;
    const forwardAngle = p.angle - Math.PI / 2;
    droppedItems.push({
        id: ++itemIdCounter,
        type: type,
        x: p.x + p.width / 2,
        y: p.y + p.height / 2,
        vx: Math.cos(forwardAngle) * dropSpeed,
        vy: Math.sin(forwardAngle) * dropSpeed,
        targetRotation: Math.random() * Math.PI * 2,
        animState: 'dropping',
        animTimer: 0.3,
        pickerId: null
    });
}

function broadcast(msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

wss.on('connection', (ws) => {
    ws.id = ++playerIdCounter;
    
    players[ws.id] = {
        id: ws.id,
        name: `Player ${ws.id}`,
        x: (MAP.columns * MAP.tileSize) / 2,
        y: (MAP.rows * MAP.tileSize) / 2,
        width: 45, height: 45,
        vx: 0, vy: 0,
        angle: 0, scale: 1, bopTimer: 0,
        inventory: ['glove', null, null, null, null],
        inventorySelected: 0,
        lastEquipped: 'glove',
        glove: { offsetX: 20, offsetY: -26, width: 22, height: 29, rotation: 0, animType: 'swing2', animSpeed: 1.2, cooldown: 0, equipTimer: 0 },
        inputs: { w: false, a: false, s: false, d: false, shift: false, isMouseDown: false },
        renderState: { animPokeOffset: 0, animRotation: 0, equipOffsetX: 20, equipOffsetY: -26, equipRot: 0 }
    };

    ws.send(JSON.stringify({ type: 'init', id: ws.id, map: MAP }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const p = players[ws.id];
            if (!p) return;

            if (data.type === 'input') {
                p.inputs = data.keys;
                p.angle = data.angle;
                p.inputs.isMouseDown = data.isMouseDown;
            } else if (data.type === 'edit') {
                const layer = MAP.layers.find(l => l.name === data.layer);
                if (layer) {
                    const idx = data.row * MAP.columns + data.col;
                    layer.data[idx] = data.gid;
                    broadcast({ type: 'map_update', layer: data.layer, col: data.col, row: data.row, gid: data.gid });
                }
            } else if (data.type === 'inv_select') {
                p.inventorySelected = data.index;
            } else if (data.type === 'inv_swap') {
                const temp = p.inventory[data.to];
                p.inventory[data.to] = p.inventory[data.from];
                p.inventory[data.from] = temp;
            } else if (data.type === 'drop') {
                if (p.inventory[data.index]) {
                    spawnDroppedItem(p.inventory[data.index], p);
                    p.inventory[data.index] = null;
                    if (p.inventorySelected === data.index) {
                        p.lastEquipped = null;
                        p.glove.cooldown = 0;
                        p.glove.equipTimer = 0;
                    }
                }
            } else if (data.type === 'pickup') {
                const item = droppedItems.find(i => i.id === data.itemId);
                if (item && item.animState !== 'picking_up' && p.inventory.includes(null)) {
                    let pdx = (p.x + p.width/2) - item.x;
                    let pdy = (p.y + p.height/2) - item.y;
                    if (Math.sqrt(pdx*pdx + pdy*pdy) < 70) {
                        item.animState = 'picking_up';
                        item.animTimer = 0.2;
                        item.pickerId = p.id;
                    }
                }
            } else if (data.type === 'glove_settings') {
                p.glove.offsetX = data.offsetX;
                p.glove.offsetY = data.offsetY;
                p.glove.width = data.width;
                p.glove.height = data.height;
                p.glove.rotation = data.rotation;
                p.glove.animType = data.animType;
                p.glove.animSpeed = data.animSpeed;
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        delete players[ws.id];
    });
});

setInterval(() => {
    const now = Date.now();
    let dt = (now - lastTime) / 1000;
    if (dt > 0.1) dt = 0.1;
    lastTime = now;

    for (let id in players) {
        const p = players[id];

        let currentEquipped = p.inventory[p.inventorySelected];
        if (currentEquipped !== p.lastEquipped) {
            if (currentEquipped === 'glove') {
                p.glove.equipTimer = 0.2;
                p.glove.cooldown = 0;
            }
            p.lastEquipped = currentEquipped;
        }

        if (p.glove.equipTimer > 0) p.glove.equipTimer = Math.max(0, p.glove.equipTimer - dt);

        let inputX = 0, inputY = 0;
        if (p.inputs.w) inputY -= 1;
        if (p.inputs.s) inputY += 1;
        if (p.inputs.a) inputX -= 1;
        if (p.inputs.d) inputX += 1;

        let isMoving = (inputX !== 0 || inputY !== 0);
        if (isMoving) {
            const length = Math.sqrt(inputX * inputX + inputY * inputY);
            inputX /= length;
            inputY /= length;
        }

        let intentSprint = p.inputs.shift && isMoving;
        if (intentSprint) p.bopTimer += dt;
        else p.bopTimer = 0;

        p.scale = 1 + (p.bopTimer > 0 ? Math.sin(p.bopTimer * 15) * 0.05 : 0);

        const friction = Math.pow(0.001, dt);
        let accel = intentSprint ? 1866 : 1493;

        p.vx += inputX * accel * dt;
        p.vy += inputY * accel * dt;
        p.vx *= friction;
        p.vy *= friction;
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        for (let i = 0; i < 3; i++) resolveCircleCollisions(p);

        if (p.x < 0) p.x = 0;
        if (p.y < 0) p.y = 0;
        if (p.x + p.width > MAP.columns * MAP.tileSize) p.x = MAP.columns * MAP.tileSize - p.width;
        if (p.y + p.height > MAP.rows * MAP.tileSize) p.y = MAP.rows * MAP.tileSize - p.height;

        if (p.glove.cooldown > 0) p.glove.cooldown -= dt * p.glove.animSpeed;
        if (p.inputs.isMouseDown && p.inventory[p.inventorySelected] === 'glove' && p.glove.cooldown <= 0 && p.glove.equipTimer <= 0) {
            p.glove.cooldown = 0.8;
        }

        p.renderState.animPokeOffset = 0;
        p.renderState.animRotation = 0;
        if (p.glove.cooldown > 0) {
            if (p.glove.animType === 'poke') {
                if (p.glove.cooldown > 0.6) {
                    p.renderState.animPokeOffset = Math.sin((0.8 - p.glove.cooldown) * 5 * Math.PI) * 20;
                }
            } else if (p.glove.animType === 'swing1' || p.glove.animType === 'swing2') {
                let mult = p.glove.animType === 'swing1' ? 1 : -1;
                let elapsed = 0.8 - p.glove.cooldown;
                if (elapsed < 0.15) {
                    p.renderState.animPokeOffset = (elapsed / 0.15) * 10;
                } else if (elapsed < 0.4) {
                    let t = (elapsed - 0.15) / 0.25;
                    p.renderState.animPokeOffset = 10 + t * 25;
                    p.renderState.animRotation = t * (Math.PI * 0.5) * mult;
                } else {
                    let t = (elapsed - 0.4) / 0.4;
                    p.renderState.animPokeOffset = 35 * (1 - t);
                    p.renderState.animRotation = (Math.PI * 0.5) * (1 - t) * mult;
                }
            }
        }

        p.renderState.equipOffsetX = p.glove.offsetX;
        p.renderState.equipOffsetY = p.glove.offsetY;
        p.renderState.equipRot = p.glove.rotation;

        if (p.glove.equipTimer > 0) {
            let t = 1 - (p.glove.equipTimer / 0.2);
            t = 1 - Math.pow(1 - t, 3);
            p.renderState.equipOffsetX = p.glove.offsetX * t;
            p.renderState.equipOffsetY = p.glove.offsetY * t;
            p.renderState.equipRot = p.glove.rotation + 120 * (1 - t);
        }
    }

    for (let i = droppedItems.length - 1; i >= 0; i--) {
        let item = droppedItems[i];
        
        if (item.animState === 'picking_up') {
            const picker = players[item.pickerId];
            if (!picker) { 
                droppedItems.splice(i, 1); 
                continue; 
            }
            const px = picker.x + picker.width / 2;
            const py = picker.y + picker.height / 2;
            item.animTimer -= dt;
            item.x += (px - item.x) * 15 * dt;
            item.y += (py - item.y) * 15 * dt;
            
            if (item.animTimer <= 0) {
                const emptySlot = picker.inventory.indexOf(null);
                if (emptySlot !== -1) {
                    picker.inventory[emptySlot] = item.type;
                }
                droppedItems.splice(i, 1);
            }
            continue;
        }

        const dropFriction = Math.pow(0.000001, dt);
        item.vx *= dropFriction;
        item.vy *= dropFriction;
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        
        if (item.x < 0) item.x = 0;
        if (item.y < 0) item.y = 0;
        if (item.x > MAP.columns * MAP.tileSize) item.x = MAP.columns * MAP.tileSize;
        if (item.y > MAP.rows * MAP.tileSize) item.y = MAP.rows * MAP.tileSize;
        
        if (item.animState === 'dropping') {
            item.animTimer -= dt;
            if (item.animTimer <= 0) {
                item.animState = 'idle';
            }
        }
    }

    broadcast({ type: 'state', players, items: droppedItems });

}, 1000 / 60);
