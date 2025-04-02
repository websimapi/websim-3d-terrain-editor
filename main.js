import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TerrainDatabase } from './terraindb.js';
import { PlayerManager } from './players.js';
import { ColorManager } from './colorManager.js';
import * as UIControls from './uiControls.js';

// Room setup for multiplayer
const room = new WebsimSocket();
let terrainHeightModifiedInStroke = false; 
let terrainColorModifiedInStroke = false; 
let myUsername = '';

// Will be initialized later
let terrainDB;
let playerManager;
let colorManager;

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); 

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 60, 60); 

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true; 
renderer.shadowMap.type = THREE.PCFSoftShadowMap; 
document.body.appendChild(renderer.domElement);

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
directionalLight.position.set(70, 120, 40);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 1;
directionalLight.shadow.camera.far = 300; 
directionalLight.shadow.camera.left = -100;
directionalLight.shadow.camera.right = 100;
directionalLight.shadow.camera.top = 100;
directionalLight.shadow.camera.bottom = -100;
directionalLight.shadow.bias = -0.001; 
scene.add(directionalLight);

// --- Terrain ---
const terrainSize = 100;
const terrainSegments = 128; 
const geometry = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainSegments, terrainSegments);
geometry.rotateX(-Math.PI / 2); 

geometry.computeVertexNormals(); 

let currentTool = 'raise'; 
const brushIndicator = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, opacity: 0.5, transparent: true })
);
brushIndicator.visible = false;
scene.add(brushIndicator);

const material = new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    metalness: 0.0,
    roughness: 0.9,
    vertexColors: false 
});

const terrain = new THREE.Mesh(geometry, material);
terrain.receiveShadow = true;
terrain.castShadow = true;
terrain.name = 'terrain'; 
scene.add(terrain);

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; 
controls.dampingFactor = 0.05;
controls.screenSpacePanning = true; 
controls.minDistance = 5;
controls.maxDistance = 150; 
controls.maxPolarAngle = Math.PI / 2.1; 
controls.target.set(0, 0, 0);
controls.zoomSpeed = 0.7; 
controls.enableZoom = true;

// --- Terrain Editing ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isMouseDown = false;

renderer.domElement.addEventListener('pointermove', onPointerMoveTerrainCheck, false);
renderer.domElement.addEventListener('pointerdown', onPointerDownTerrain, false);
window.addEventListener('pointerup', onPointerUpTerrain, false); 
window.addEventListener('resize', onWindowResize, false);
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('toolChanged', (event) => {
    currentTool = event.detail.tool; 
    updateBrushIndicator(); 
});

function onPointerMoveTerrainCheck(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    updateBrushIndicator(); 

    if (isMouseDown && UIControls.getCurrentTool() !== 'select') {
        applyBrush(); 
    }
}

function onPointerDownTerrain(event) {
    if (UIControls.isUIInteraction(event.target)) return;
    if (event.target !== renderer.domElement) return; 
    if (event.button !== 0) return; 

    isMouseDown = true;
    const tool = UIControls.getCurrentTool();

    if (tool !== 'select') {
        controls.enabled = false; 
        updateBrushIndicator(); 
        terrainHeightModifiedInStroke = false;
        terrainColorModifiedInStroke = false;
        applyBrush(); 
    } else {
         controls.enabled = true; 
    }
}

function onPointerUpTerrain(event) {
    if (event.button === 0 && isMouseDown) {
        isMouseDown = false;
        controls.enabled = true; 

        const tool = UIControls.getCurrentTool();

        if (terrainHeightModifiedInStroke && terrainDB && (tool === 'raise' || tool === 'lower' || tool === 'flatten')) {
            console.log("Stroke ended, saving height changes...");
            terrainDB.saveTerrainChanges(); 
            terrainHeightModifiedInStroke = false; 
        }

        if (terrainColorModifiedInStroke && colorManager && tool === 'color') {
            console.log("Stroke ended, saving color changes...");
            colorManager.saveColorData(); 
            terrainColorModifiedInStroke = false; 
        }
    }
}

function applyBrush() {
    const tool = UIControls.getCurrentTool();
    if (tool === 'select' || !terrainDB || !colorManager) return; 

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        const hitPoint = intersection.point;
        const brushSettings = UIControls.getBrushSettings();
        const brushRadius = brushSettings.size;
        const brushStrength = brushSettings.strength; 
        const targetFlattenHeight = brushSettings.flattenHeight;

        const positions = geometry.attributes.position;
        const vertex = new THREE.Vector3();
        let geometryNeedsUpdate = false; 

        if (tool === 'color') {
            const targetColor = new THREE.Color(colorManager.currentColor);
            let colorApplied = false;
            for (let i = 0; i < positions.count; i++) {
                 vertex.fromBufferAttribute(positions, i);
                 const dx = vertex.x - hitPoint.x;
                 const dz = vertex.z - hitPoint.z;
                 const distance = Math.sqrt(dx * dx + dz * dz);

                 if (distance < brushRadius) {
                    const currentColorHex = colorManager.currentUserColorData[String(i)];
                    if (currentColorHex !== colorManager.currentColor) {
                         colorManager.applyColorChange(i, colorManager.currentColor);
                         terrainColorModifiedInStroke = true;
                         colorApplied = true;
                    }
                 }
            }
            if (colorApplied) {
            }
            return; 
        }

        let heightChanged = false;
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                 const falloff = Math.cos((distance / brushRadius) * Math.PI / 2); 
                 const strengthFactor = brushStrength * falloff * 0.15; 
                 const currentHeight = terrainDB.currentUserHeightData[String(i)] ?? positions.getY(i); 
                 let newHeight = currentHeight;

                if (tool === 'raise') {
                    newHeight = currentHeight + strengthFactor;
                } else if (tool === 'lower') {
                    newHeight = currentHeight - strengthFactor;
                } else if (tool === 'flatten') {
                    newHeight = THREE.MathUtils.lerp(currentHeight, targetFlattenHeight, strengthFactor * 0.5); 
                }

                if (Math.abs(newHeight - currentHeight) > 0.001) {
                    terrainDB.applyHeightChange(i, newHeight); 
                    heightChanged = true;
                }
            }
        }

        if (heightChanged) {
            terrainHeightModifiedInStroke = true;
        }
    }
}

function updateBrushIndicator() {
    const tool = UIControls.getCurrentTool();
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0 && tool !== 'select') {
        const intersection = intersects[0];
        brushIndicator.position.copy(intersection.point);
        const brushSettings = UIControls.getBrushSettings();
        const scale = brushSettings.size * 0.25;
        brushIndicator.scale.set(scale, scale, scale);
        brushIndicator.visible = true;

        if (tool === 'color' && colorManager) {
            brushIndicator.material.color.set(colorManager.currentColor);
            brushIndicator.material.wireframe = false;
            brushIndicator.material.opacity = 0.6;
        } else {
            brushIndicator.material.color.set(0xffffff);
            brushIndicator.material.wireframe = true;
            brushIndicator.material.opacity = 0.5;
        }
    } else {
        brushIndicator.visible = false;
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

async function initializeMultiplayer() {
    try {
        console.log("Initializing multiplayer...");
        await room.initialize();
        while (!room.clientId || !room.peers[room.clientId]) {
             console.log("Waiting for room client ID and peer info...");
             await new Promise(resolve => setTimeout(resolve, 100));
         }
        myUsername = room.peers[room.clientId].username;
        console.log(`Connected as: ${myUsername}`);

        colorManager = new ColorManager(room, geometry, scene);
        await colorManager.initialize(); 

        terrainDB = new TerrainDatabase(room, geometry, scene);
        await terrainDB.initialize(); 

        playerManager = new PlayerManager(room, scene);
        playerManager.initialize(); 

        UIControls.initializeUI(colorManager);
        UIControls.ensureColorButton();

        setInterval(() => {
            if (playerManager) {
                playerManager.updatePlayerPosition(camera, controls);
            }
        }, 200); 

        console.log("Multiplayer initialization complete.");
        if (geometry.attributes.position) geometry.attributes.position.needsUpdate = true;
        if (geometry.attributes.color) geometry.attributes.color.needsUpdate = true;
        geometry.computeVertexNormals();

    } catch (error) {
        console.error('Error initializing multiplayer:', error);
        const status = document.getElementById('save-status');
        if (status) {
            status.textContent = "Initialization Error!";
            status.style.opacity = '1';
            status.style.backgroundColor = 'rgba(220,53,69,0.7)';
        }
    }
}

function animate() {
    requestAnimationFrame(animate);

    controls.update(); 

    if (playerManager) {
        playerManager.renderPlayerPositions();
    }

    renderer.render(scene, camera);
}

initializeMultiplayer(); 
animate(); 